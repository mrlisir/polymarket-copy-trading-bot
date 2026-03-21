# CHANGELOG V1 - 反买模式修复

## 版本日期: 2026-03-20

---

## 更新日志

### 第二次修复 (2026-03-20)

**问题**: API 端点仍然无法获取反向代币，所有方法都返回 404 或空数据。

**解决方案**: 增强 `fetchOppositeAsset` 函数，添加更多 API 端点和更详细的日志。

新增方法:
- Method 2: 使用 data API markets 端点
- Method 3: 使用备用 CLOB 端点
- 更详细的日志输出便于调试

---

## 问题描述

### 原问题
启用反买模式 (REVERSE mode) 后，系统无法正确执行反向交易，日志显示:
```
⚠️  缺少反向代币 (oppositeAsset: undefined)，无法执行 REVERSE 交易，跳过
```

### 根本原因
1. `fetchOppositeAsset` 函数使用的 Polymarket API 无法正确获取反向代币
2. REVERSE 模式下，代码仍然交易与交易员相同的资产，而不是交易相反的资产
3. 在查找持仓时没有正确匹配 `oppositeAsset`

---

## 解决方案

### 1. 修复 `fetchOppositeAsset` 函数 (`src/services/tradeMonitor.ts`)

**修改前**: 原有 API 调用无法正确获取反向代币信息

**修改后**:
- 添加多种 API 获取方式作为备份
- 使用正确的 Polymarket CLOB API 端点
- 添加详细的日志输出便于调试

```typescript
// 新的获取方法包括:
// 1. CLOB markets API - condition_id 查询
// 2. 直接获取市场详情 API
// 3. 遍历所有 outcomes 找到反向代币
```

---

### 2. 修改 `tradeExecutor.ts` 中的持仓匹配逻辑

**修改前**:
```typescript
const my_position = my_positions.find(
    (position: UserPositionInterface) => position.conditionId === trade.conditionId
);
```

**修改后**:
```typescript
// In REVERSE mode, find position on opposite side (we hold opposite tokens to trader)
// In FOLLOW mode, find position on same side as trader
let my_position = my_positions.find((position: UserPositionInterface) => {
    if (ENV.COPY_STRATEGY_CONFIG.copyMode === CopyMode.REVERSE) {
        // REVERSE: match oppositeAsset to our position asset
        return position.conditionId === trade.conditionId && position.asset === trade.oppositeAsset;
    }
    // FOLLOW: match same asset as trader
    return position.conditionId === trade.conditionId && position.asset === trade.asset;
});
```

**影响文件**: 
- `doTrading` 函数
- `doAggregatedTrading` 函数

---

### 3. 修改 `postOrder.ts` 中的反向交易逻辑

#### 3.1 `getPositionAsset` 函数

**修改前**: REVERSE 模式下仍然返回 `trade.asset`

**修改后**:
```typescript
const getPositionAsset = (trade: UserActivityInterface): string => {
    if (isReverseMode()) {
        if (trade.oppositeAsset) {
            Logger.info(`🔄 反买模式: 交易员交易 ${trade.asset} → 我反向交易 ${trade.oppositeAsset}`);
            return trade.oppositeAsset;
        } else {
            Logger.warning(`⚠️  反买模式缺少反向代币 (oppositeAsset)，将使用相同代币 ${trade.asset}`);
            return trade.asset;
        }
    }
    return trade.asset;
};
```

#### 3.2 卖出策略中的资产匹配

**修改前**: 历史买入记录查询使用 `trade.asset`

**修改后**:
```typescript
// Determine which asset we're selling
const sellAsset = isReverseMode() ? (trade.oppositeAsset || trade.asset) : trade.asset;

// Get all previous BUY trades for this asset to calculate total bought
const previousBuys = await UserActivity.find({
    asset: sellAsset,  // 使用 sellAsset 而不是 trade.asset
    conditionId: trade.conditionId,
    side: 'BUY',
    bot: true,
    myBoughtSize: { $exists: true, $gt: 0 },
}).exec();
```

---

## 反买模式工作原理

### Polymarket 代币机制
- 每个预测市场有 YES 和 NO 两种代币
- YES 代币在市场做对时价值 $1，否则价值 $0
- NO 代币与 YES 代币价值相反

### REVERSE 模式逻辑

| 交易员操作 | 我的操作 (REVERSE) | 说明 |
|-----------|------------------|------|
| BUY YES | BUY NO | 交易员买入 YES，我买入反向的 NO |
| SELL YES | SELL NO | 交易员卖出 YES，我卖出我持有的 NO |

### 持仓匹配规则

**REVERSE 模式**:
- 我持有的代币与交易员相反
- 如果交易员持有 YES 代币，我持有 NO 代币
- 卖出时查找 `oppositeAsset` 对应的持仓

---

## 新增日志输出

修复后，日志将显示更多信息:

```
🔄 反买模式: 交易员 BUY YES (0x123...) → 我反向交易 0x456... (NO 代币)
   原始订单: BUY $10.00 @ $0.60
📊 计算跟单: $1.00 | 10.00% of trader's $10.00 = $1.00
正在下单: $1.00 @ $0.41 (余额: $50.00)
✅ 买入成功: $1.00 @ $0.41 (2.44 个代币)
```

---

## 测试建议

1. 确认 `.env` 中 `COPY_MODE=REVERSE` 已设置
2. 使用 dry-run 模式测试: `npm run dry-run`
3. 观察日志确认 `oppositeAsset` 已正确获取
4. 确认买单/卖单使用的是反向代币

---

## 相关文件变更

| 文件 | 变更类型 | 说明 |
|-----|---------|------|
| `src/services/tradeMonitor.ts` | 修改 | 增强 `fetchOppositeAsset` 函数 |
| `src/services/tradeExecutor.ts` | 修改 | 修复 REVERSE 模式持仓匹配 |
| `src/utils/postOrder.ts` | 修改 | 修复反向交易资产选择 |

---

## 注意事项

1. **首次运行**: 首次启用 REVERSE 模式时，`oppositeAsset` 可能需要通过 API 获取
2. **缓存**: 已有的交易历史记录可能缺少 `oppositeAsset`，新检测到的交易会正确填充
3. **余额**: 确保钱包持有 USDC 用于购买反向代币
