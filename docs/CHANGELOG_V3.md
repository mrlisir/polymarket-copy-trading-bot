# Changelog - V3

> 本文档记录 V3 阶段新增改动，重点是「已结算仓位资金释放」与「默认配置开启」。
> 前置背景见：`docs/CHANGELOG_V2.md`、`docs/CHANGELOG_V1.md`。

---

## 一、已结算仓位：CLOB 不完全成交时自动补 Redeem

**文件**：`src/services/positionReconciliation.ts`

### 背景

- 仅依赖订单簿卖出时，已结算市场可能因无流动性/盘口异常导致仓位残留，资金无法及时回到 USDC。

### 改动

- `flattenLivePosition(...)` 返回成交结果（初始代币、已卖代币、卖出 USD）。
- 对账走到「已结算路径」后：
  - 先尝试 CLOB 卖出；
  - 若 `POSITION_RECONCILE_AUTO_REDEEM=true`，且满足以下任一条件，则触发链上赎回：
    - `pos.redeemable === true`
    - CLOB 未完全成交（卖出 < 95%）
- 同一轮对同一 `conditionId` 只尝试一次 redeem，避免重复提交链上交易。
- 日志新增剩余代币提示，便于判断赎回触发原因。

---

## 二、Redeem 成功后打印 USDC 余额增量

**文件**：`src/utils/ctfRedeem.ts`

### 改动

- 提交赎回前读取钱包 USDC 余额；
- 赎回成功后再次读取 USDC 余额；
- 输出余额变化日志：
  - `赎回前 -> 赎回后`
  - `回收 +$X.XX`

### 作用

- 让「是否释放了闲置资金」可直接从日志观察，不需要手动对账。

---

## 三、默认配置改为开启（`.env` / `.env.example`）

### 已显式开启项

- `COPY_DOUBLE_SIDE_GUARD_MODE=GLOBAL`
- `POSITION_RECONCILE_ON_TRADER_EXIT=true`
- `POSITION_RECONCILE_ON_RESOLVED=true`
- `POSITION_RECONCILE_AUTO_REDEEM=true`

### 影响

- 默认更偏向“资金回收优先 + 防两头买”的保守实盘策略；
- 启动后无需额外手动打开上述关键开关。

---

## 四、验证

- `npm run build` 已通过（TypeScript 无报错）。
- 相关改动未引入新增 linter 错误。

---

## 五、下单成功邮件通知（QQ SMTP）

**文件**：`src/utils/emailNotifier.ts`、`src/utils/postOrder.ts`、`src/config/env.ts`

- 新增 `notifyOrderSuccess(...)`：买入/卖出成功后发送邮件。
- 发送时机：`postOrder` 的 BUY / SELL 成交成功分支。
- 邮件内容包含：北京时间、方向、金额、价格、数量、市场、交易员、tokenId、conditionId、txHash。

**配置（`.env` / `.env.example`）**：

- `EMAIL_NOTIFY_ENABLED`
- `EMAIL_SMTP_HOST`（默认 `smtp.qq.com`）
- `EMAIL_SMTP_PORT`（默认 `465`）
- `EMAIL_SMTP_SECURE`（默认 `true`）
- `EMAIL_SMTP_USER`
- `EMAIL_SMTP_PASS`（QQ 授权码，不是登录密码）
- `EMAIL_FROM`（可选）
- `EMAIL_NOTIFY_TO`（可多收件人，逗号分隔）

