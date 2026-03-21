# Changelog - V2

> 本文档汇总 V2 阶段对「模拟跟单、估值、对账、API 负载、Builder」等能力的改动，便于对照代码与配置。  
> 前置背景见：`docs/CHANGELOG_V1.md`（REVERSE、复合 key、对账框架等）。  
> 后续增强见：`docs/CHANGELOG_V3.md`（结算后自动赎回补偿、赎回回款日志、默认开关）。

---

## 一、环境变量（`.env` / `.env.example` / `src/config/env.ts`）

### 1. Data API 与 CLOB 轻量价格（V2 新增）

| 变量 | 默认 | 说明 |
|------|------|------|
| `DATA_API_POSITIONS_CACHE_TTL_MS` | `10000` | `positions?user=` 多模块共享内存缓存 TTL（毫秒），减少同一轮内重复请求。 |
| `CLOB_LIGHT_PRICE_CACHE_TTL_MS` | `15000` | CLOB 公开 `/midpoint`、`/last-trade-price` 结果缓存 TTL，估值优先于整本 `/book`。 |
| `COPY_DOUBLE_SIDE_GUARD_MODE` | `GLOBAL` | 两头买风控：`GLOBAL` / `TRADER_ONLY` / `OFF`。 |

**同步要求**：已在 `src/config/env.ts` 解析；`.env.example` 中有注释示例；本地可在 `.env` 中显式写出以便调参。

### 2. Polymarket Builder API（可选）

| 变量 | 说明 |
|------|------|
| `POLY_BUILDER_API_KEY` | Builder 公钥标识（与 Polymarket 后台「Builders」一致） |
| `POLY_BUILDER_SECRET` | 签名用密钥，**勿提交 Git、勿发聊天** |
| `POLY_BUILDER_PASSPHRASE` | 与 secret 配套的口令 |

三者**须同时配置**才会在创建 CLOB 客户端时注入 `BuilderConfig`；用于下单时附带 Builder 认证头（订单归因、Builder 计划/排行榜）。与 [Relayer 文档](https://docs.polymarket.com/api-reference/relayer/submit-a-transaction) 中的 Builder 头为同一套体系；**本仓库未封装 Relayer `POST /submit` gasless 交易**。

### 3. 与 V1 已存在、仍与 V2 逻辑强相关的变量

- `POSITION_RECONCILE_*`、`POSITION_RECONCILE_ON_RESOLVED`、`POSITION_RECONCILE_AUTO_REDEEM`：实盘与 `npm run dryrun` 共用。
- `CUR_PRICE_CACHE_TTL_MS`、`MARK_CUR_VS_BOOK_DIVERGENCE`：与 `tokenMark.resolveTokenMarkUsd` 仍相关；V2 在「订单簿」前增加了轻量价与 Gamma 层级。

---

## 二、估值链路（`resolveTokenMarkUsd`）

**文件**：`src/utils/tokenMark.ts`  

单 token 估值顺序（与 [Polymarket API 概述](https://docs.polymarket.com/api-reference/introduction) 中 Data / CLOB / Gamma 分工一致）：

1. **Data API**：`positions` 中的 `curPrice`（含 **`0`**，已结算输侧；此前 `>0` 过滤会导致无法判结算）。
2. **已结算信任区间**：`curPrice ≤ 0.01` 或 `≥ 0.99` 时直接采用，避免无订单簿时误用陈旧盘口 mid。
3. **CLOB 轻量接口**：`src/utils/clobPublicPrice.ts` → `/midpoint` → `/last-trade-price`（带 `CLOB_LIGHT_PRICE_CACHE_TTL_MS` 缓存）。
4. **Gamma 已收盘**：若调用方传入 `conditionId`，则 `src/utils/gammaSettlement.ts` 中按 `closed` + `outcomePrices` 与 `clobTokenIds` 对齐得到该 token 的展示价（**不限** 0.99/0.01，用于估值补全）。
5. **整本订单簿**：`postOrder.fetchOrderBookCached`（仍用于深度与背离对比；404 时前置步骤已尽量兜底）。

**可选参数**：`resolveTokenMarkUsd(clob, tokenId, { curPriceHint?, conditionId? })`  

- **Dry run**：`getValuationPriceUsd` 对模拟持仓传入 `conditionId`。  
- **实盘**：`getProxyPortfolioMarkUsd(clob)` 从代理钱包 positions 行读取 `conditionId` 并下传（在 `LIVE_PORTFOLIO_CURPRICE_LOG_INTERVAL_MS > 0` 打持仓总市值日志时生效）。

---

## 三、Data API `positions` 统一缓存

**文件**：`src/utils/dataApiCache.ts`  

- `fetchPositionsForUser(user, { force? })`：`positions?user=` 带 TTL（`DATA_API_POSITIONS_CACHE_TTL_MS`），失败时可返回最近一次成功缓存。  
- `fetchPositionsForUserForce(user)`：强制拉新（用于 `refreshCurPriceMap(true)`）。

**已接入模块**（实盘 `npm run dev` / `npm start` 与 dry run 共用逻辑处）：

- `src/utils/positionValuation.ts`（`refreshCurPriceMap`）
- `src/services/tradeMonitor.ts`（每轮先拉代理持仓一次、多交易员复用；去掉对同一交易员 `positions` 的重复请求）
- `src/services/tradeExecutor.ts`
- `src/services/positionReconciliation.ts`
- `src/services/positionReconciliationCore.ts`（`anyTraderStillInMirror`）
- `src/services/dryRunExecutor.ts`（含 `buildRedeemableByAssetMerged`、Outcome 回补等）
- `src/utils/tokenMark.ts`（`getProxyPortfolioMarkUsd`）

**未缓存**：`activity?type=TRADE` 仍按原频率请求，避免延迟发现新成交。

---

## 四、模拟跟单（Dry Run）与对账

**主文件**：`src/services/dryRunExecutor.ts`

### 4.1 持仓明细与 Outcome

- `SimulatedPosition` 增加 `outcome`；买入/加仓时写入；`DRY_START_FROM_REAL` 基线从 API 带入 `outcome`。
- `printSimulatedPositionsSnapshot`：每行打印 **Outcome**；缺失时用 `buildAssetOutcomeLookup()`（代理钱包 + `USER_ADDRESSES` 的 `positions`）按 `asset` 回补。

### 4.2 已 Resolved 仍占仓、现金不更新

**原因归纳**：仅代理钱包 `redeemable`、或 `curPrice` 未落在 0/1、或 `curPrice=0` 被旧逻辑丢弃等。

**改动要点**：

- `buildRedeemableByAssetMerged`：**PROXY_WALLET + USER_ADDRESSES** 的 `positions` 合并，`redeemable === true` 任一为真即视为可赎回信号（纯模拟时代理无仓也能跟到交易员侧信号）。
- `isMarketResolved` 仍定义在 `positionReconciliationCore.ts`；配合 **Gamma**：`fetchGammaSettlementInfoCached` + `gammaTokenLooksSettled`（`closed` 且 outcome 价贴 0/1）参与「已结算」判定。
- `simulateReconcileFlatten`：先 CLOB 模拟卖；失败或无买盘且 `settledCashout` 时按 **`resolveSettlementPxForDryRun`** 兑付并删仓；**已结算路径不受 `RECONCILE_MIN_SELL_TOKENS` 限制**（碎股也可清）。
- `runDryRunPositionReconciliation`：先处理 `resolved`，再对「交易员离场」分支做最小卖出份额判断，避免 resolved 被 `continue` 掉。
- 对账循环中 **`curPrice` 补全**：`getValuationPriceUsd(..., conditionId)`，且仅当 `curPrice` 非有限或 **`< 0`** 时用估值补（**保留 0** 作为有效结算价）。

### 4.3 Gamma 工具模块

**文件**：`src/utils/gammaSettlement.ts`

- `fetchGammaSettlementInfoCached(conditionId)`：Gamma `markets?condition_id=`，解析 `closed`、`clobTokenIds`、`outcomePrices`。
- `gammaTokenLooksSettled`：用于**模拟结算平仓**判定（价贴 0/1）。
- `gammaClosedValuationUsd` / `getGammaValuationUsdForAsset`：用于**展示估值**（已收盘即可用 outcome 价，不限极端）。

---

## 五、实盘 CLOB 客户端与 Builder

**文件**：`src/utils/createClobClient.ts`

- 在取得用户 API creds 后构造 `ClobClient` 时，若 `POLY_BUILDER_*` 三者齐全，则传入 `BuilderConfig({ localBuilderCreds })`。
- 依赖：`@polymarket/builder-signing-sdk`（`package.json` 已声明）。

---

## 五点五、实盘反买稳定性补丁（token 错配与重复执行）

### A) conditionId 白名单校验 oppositeAsset

- 新增 `src/utils/conditionTokens.ts`：
  - `getConditionTokenIdsCached(conditionId)`：从 Gamma 读取该市场合法 token 列表（缓存 60s）。
  - `resolveReverseAssetForCondition(conditionId, traderAsset, candidateOpposite)`：只允许使用同一 `conditionId` 下的 opposite token，避免误用旧市场 token 导致 CLOB 404。
- 接入点：
  - `tradeMonitor`：写库前校验并修正 `oppositeAsset`。
  - `tradeExecutor`：执行前再次校验；聚合执行也会校验并批量修正。

### B) 执行器短期去重

- `tradeExecutor` 增加 `transactionHash` 维度短期去重（10 分钟）：
  - key=`userAddress:txHash:asset:side`
  - 命中后直接标记已处理并跳过，防止同一笔在 API 抖动/重复记录时反复尝试。

### C) 反买 Outcome 兜底反推

- `src/utils/copyOutcomeLabels.ts`：当 `oppositeOutcome` 缺失时，支持从已知对（`Up/Down`, `Yes/No` 等）自动反推，减少“未知”文案。

### D) 二元市场：对侧 token 仅以 Gamma `clobTokenIds` 为准

- **现象**：已设 `COPY_MODE=REVERSE`，但 Polymarket Positions 上与交易员看起来是**同一 outcome**（或日志与 UI 对不上）。
- **原因**：Data API 里 `oppositeAsset` / `outcome` 文案偶发与**真实 clob token** 映射不一致；旧逻辑若「采信 API 给出的对侧 id」，可能仍买到与交易员**同一腿**。
- **改动**：
  - `resolveReverseAssetForCondition`：当 Gamma 返回**恰好 2 枚** token 时，**强制**对侧 = 与 `traderAsset` 不同的那一枚（忽略 API `candidateOpposite`）。
  - `getConditionTokensMetaCached` + `outcomeLabelForAsset`：顺带缓存 `outcomes`（与 `clobTokenIds` 下标对齐）。
  - `postOrder`：买/卖前再次解析并写回内存中的 `trade.oppositeAsset`；反买买入前打印 `🔬 Gamma 核对 outcome`（便于用日志对照链上 `token_id` / 交易哈希）。

---

## 六、命令与行为对照

| 命令 | V2 相关行为 |
|------|-------------|
| `npm run dryrun` | 上述 dry run 持仓、Outcome、对账、估值链、Data 缓存、Gamma。 |
| `npm run dev` / `npm start` | 共用 `tradeMonitor` / `tradeExecutor` / 对账的 **positions 缓存**；**完整 `resolveTokenMarkUsd` 链**主要在 `getProxyPortfolioMarkUsd`（受 `LIVE_PORTFOLIO_CURPRICE_LOG_INTERVAL_MS` 控制）。**真实下单**仍以订单簿为主（`postOrder`）。 |

更细的对称清单见：`docs/DRY_RUN_LIVE_PARITY.md`（已随 V2 补充共享模块引用）。

---

## 七、相关源文件清单（便于 Code Review）

| 路径 | 作用 |
|------|------|
| `src/utils/clobPublicPrice.ts` | CLOB 轻量价格 + 缓存 |
| `src/utils/dataApiCache.ts` | Data `positions` 缓存 |
| `src/utils/gammaSettlement.ts` | Gamma 收盘 / 结算 / 估值 |
| `src/utils/tokenMark.ts` | 估值顺序、代理组合市值 |
| `src/utils/positionValuation.ts` | curPrice 图 + `parseCurPrice` 允许 0 |
| `src/utils/createClobClient.ts` | 可选 Builder |
| `src/config/env.ts` | 上述 env 解析 |
| `src/services/dryRunExecutor.ts` | 模拟执行、对账、快照、merged redeemable |
| `src/services/tradeMonitor.ts` | positions 缓存与去重 |
| `src/services/tradeExecutor.ts` | positions 缓存、组合日志 |
| `src/services/positionReconciliation.ts` | positions 缓存 |
| `src/services/positionReconciliationCore.ts` | `isMarketResolved`、镜像腿、positions 拉取 |
| `.env.example` | 新变量说明与 Builder 安全提示 |

---

## 八、版本建议

- 若发布 npm 包或打 Tag，可将 **`package.json` 的 `version`** 升为 `2.x` 与本文档 V2 对齐（当前以仓库文档为准）。
