# Changelog - V1

> 本文档记录 V1 版本的所有新增功能和代码改动。

**续篇**：模拟估值、Data/CLOB/Gamma 优化、Builder、对账与 Outcome 等见 [**CHANGELOG_V2.md**](./CHANGELOG_V2.md)。

---

## 新增参数

### `.env` 新增参数

#### 跟单方向模式 `COPY_MODE`
```bash
# 跟单方向模式
COPY_MODE = 'FOLLOW'   # FOLLOW=跟方向，REVERSE=反买
```

- **FOLLOW**（默认）：交易员买什么（YES/NO），我就买什么
- **REVERSE**：交易员买什么（YES/NO），我就买对侧（买另一种代币）

#### 模拟跟单参数
```bash
# 初始模拟余额（USD）
DRY_INITIAL_BALANCE=1000

# 是否加载真实持仓作为起点
# true = 从跟单钱包当前真实持仓开始模拟
# false = 从零开始
DRY_START_FROM_REAL=true
```

**移除的旧参数**（已废弃，不再支持历史回放）：
- `DRY_HISTORY_HOURS`
- `DRY_REPLAY_SPEED`
- `DRY_REALTIME`

> 运行命令：`npm run dryrun`

---

## 新增功能

### 1. REVERSE 反买模式（核心新功能）

#### 功能说明
REVERSE 模式下，机器人会在交易员建仓时买入**对侧代币**，在交易员平仓时卖出**对侧代币**，而非简单地反向下单。

#### 举例：`BNB Up or Down - March 19` 市场

| 场景 | 交易员动作 | FOLLOW 模式（我） | REVERSE 模式（我） |
|------|-----------|-----------------|-----------------|
| 建仓 | 买 YES token | 买 YES token | 买 NO token |
| 平仓 | 卖 YES token | 卖 YES token | 卖 NO token |
| 建仓 | 买 NO token | 买 NO token | 买 YES token |
| 平仓 | 卖 NO token | 卖 NO token | 卖 YES token |

#### 内部实现逻辑

**REVERSE BUY 时自动平仓对侧**：
```
Trader 买 YES → 我要买 NO
  如果此时已有 YES 持仓 → 先卖出平仓 → 再买入 NO
```
使用订单簿的 bids（买方）立即平仓对侧持仓，再使用 asks（卖方）买入目标代币。

#### 相关文件
- `src/config/copyStrategy.ts` - CopyMode 枚举和 getActualSide 函数
- `src/services/dryRunExecutor.ts` - REVERSE 模式持仓管理和订单簿查询
- `src/services/tradeMonitor.ts` - 新增 oppositeAsset 字段写入

---

### 2. 模拟持仓按 conditionId:asset 复合 key 存储

#### 改动说明
原来模拟持仓用 `conditionId` 单一 key，无法区分同一个市场的 YES 和 NO 两种代币。现在改为 `conditionId:asset` 复合 key，YES 和 NO 独立管理，互不影响。

```typescript
// 新 key 格式
const posKey = (conditionId: string, asset: string) => `${conditionId}:${asset}`;

// 示例
"0xabc123:123456789" → YES token 持仓
"0xabc123:987654321" → NO token 持仓
```

#### 影响范围
- 加载真实持仓初始化（`initSimulatedAccount`）
- 每次模拟交易更新持仓（`doDryTrading`）
- REVERSE 模式对侧代币查询

#### 相关文件
- `src/services/dryRunExecutor.ts`

---

## 代码修改详情

### `src/services/tradeMonitor.ts`

**改动**：在写入 MongoDB activity 记录时，新增 `oppositeAsset` 字段。

```typescript
// 新增第 151 行
side: activity.side,
outcomeIndex: activity.outcomeIndex,
oppositeAsset: activity.oppositeAsset,  // ← 新增
title: activity.title,
```

**原因**：REVERSE 模式需要知道当前这笔交易的对侧代币 ID，才能买入/卖出正确的代币。

---

### `src/services/dryRunExecutor.ts`

**核心改动**：`doDryTrading` 函数完全重写，支持 REVERSE 模式。

#### 主要逻辑变更

1. **确定实际交易的代币**：
   ```typescript
   const tradeAsset = isReversed ? trade.oppositeAsset : trade.asset;
   ```
   - FOLLOW：直接用 `trade.asset`
   - REVERSE：用 `trade.oppositeAsset`（对侧代币）

2. **复合 key 持仓管理**：
   ```typescript
   const myHoldingKey = posKey(trade.conditionId, tradeAsset);
   const oppositeKey = posKey(trade.conditionId, trade.oppositeAsset);
   ```

3. **REVERSE BUY 时自动平仓**：
   ```typescript
   const oppositePos = simulatedPositions.get(oppositeKey);
   if (isReversed && oppositePos && oppositePos.size > 0) {
       // 先卖出对侧代币平仓
       const closeResult = simulateFillSell(oppositePos.size, orderBook.bids);
       // 输出平仓信息
       console.log(`  🔄 平仓: 卖出 ${closeResult.tokens} ... @ $${closeResult.avgPrice} → $${closeResult.proceeds}`);
       console.log(`  📈 平仓盈亏: $${pnl}`);
       simulatedBalance += closeResult.proceeds;
       simulatedPositions.delete(oppositeKey);
   }
   ```

4. **BUY/SELL 分支使用正确的 key**：
   - 持仓 key 改为 `myHoldingKey`（`conditionId:asset`）
   - 不再依赖 `simulatedPositions.get(trade.conditionId)` 查持仓

#### 相关文件
- `src/services/dryRunExecutor.ts`

---

### `src/utils/postOrder.ts`

**说明**：此文件为实盘下单逻辑，`tradeExecutor.ts` 调用 `getActualSide` 后传入 `postOrder`，REVERSE 模式在 `tradeExecutor.ts` 层已处理（`actualSide` 已是反转后的方向）。`postOrder.ts` 本身逻辑无需改动。

---

### `.env` / `.env.example`

#### 变更内容

| 变更 | 文件 |
|------|------|
| 新增 `COPY_MODE` 参数 | `.env` / `.env.example` |
| 新增 `DRY_INITIAL_BALANCE` 参数 | `.env` / `.env.example` |
| 新增 `DRY_START_FROM_REAL` 参数 | `.env` / `.env.example` |
| 移除 `DRY_HISTORY_HOURS` 参数 | `.env` |
| 移除 `DRY_REPLAY_SPEED` 参数 | `.env` |
| 移除 `DRY_REALTIME` 参数 | `.env` |
| 更新注释说明 | `.env` / `.env.example` |

---

## 文件变更清单

### 修改的文件
```
.env                              # 新增参数、清理旧参数
.env.example                      # 新增参数、简化注释
src/services/tradeMonitor.ts     # 新增 oppositeAsset 字段写入
src/services/dryRunExecutor.ts   # REVERSE 模式核心逻辑重写
```

### 改动统计
- 新增参数：3 个
- 移除参数：3 个（已废弃）
- 修改文件：4 个
- 核心逻辑改动：1 处（doDryTrading 函数）

---

## 使用方式

### 启用反买
在 `.env` 中修改：
```bash
COPY_MODE = 'REVERSE'
```

### 运行模拟测试
```bash
npm run dryrun
```

### 预期输出示例（REVERSE 模式）

```
  📊 2024/3/20 14:30:22
  市场: BNB Up or Down - March 19
  交易员: 0xd62F...3A2b
  原始订单: BUY $50.00 @ $0.55
  🔄 反买模式: BUY → 我买对侧 SELL
  → 代币: 0xYES... → 0xNO...
  🔄 平仓: 卖出 10.5 YES @ $0.55 → $5.77
  📈 平仓盈亏: +$0.00 (成本 $5.77)
  ✅ 模拟买入: $2.00 → 4.0 NO tokens @ $0.50
  💰 余额: $1000.00 → $1003.77
  📋 模拟账户: 余额 $1003.77 | 持仓 2 个 | 净值 $1005.77
```

---

## 注意事项

1. **REVERSE 模式需要交易员 activity 数据包含 `oppositeAsset` 字段**。如果 `trade.oppositeAsset` 为空，REVERSE 交易将被跳过并输出警告。

2. **FOLLOW 模式不受影响**，所有原有逻辑保持不变。

3. **持仓初始化**：`DRY_START_FROM_REAL=true` 时，会从 Polymarket API 加载跟单钱包的真实持仓，按 `conditionId:asset` 格式存入模拟账户。

4. **盈亏计算**：REVERSE 模式下，平仓盈亏基于平仓价格与对侧代币持仓均价的差值计算。

---

## 下一步计划（待开发）

- [ ] 实盘 `tradeExecutor.ts` 支持 REVERSE 模式下的 oppositeAsset 下单
- [ ] REVERSE 模式持仓同步（实盘运行时需要维护 NO token 持仓记录）
- [ ] 历史回测数据回放（REVERSE 模式）
- [ ] 独立 REVERSE 模式日志标记，便于统计

