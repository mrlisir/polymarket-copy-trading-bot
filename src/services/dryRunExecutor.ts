import { ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import { CopyMode, getActualSide, calculateOrderSize, getTradeMultiplier } from '../config/copyStrategy';
import { UserPositionInterface } from '../interfaces/User';
import { fetchPositionsForUser, fetchPositionsForUserForce } from '../utils/dataApiCache';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import { getCurPriceForAsset, refreshCurPriceMap } from '../utils/positionValuation';
import { fetchOrderBookCached } from '../utils/postOrder';
import { resolveTokenMarkUsd } from '../utils/tokenMark';
import {
    RECONCILE_MIN_SELL_TOKENS,
    RESOLVED_HIGH,
    RESOLVED_LOW,
    anyTraderStillInMirror,
    getMirrorAssetForReconcile,
    isMarketResolved,
    loadCopiedConditionTraders,
    positionKey,
} from './positionReconciliationCore';
import { fetchGammaSettlementInfoCached, gammaTokenLooksSettled } from '../utils/gammaSettlement';
import { resolveCopyOutcomeLabels } from '../utils/copyOutcomeLabels';
import { formatBeijingDateTime } from '../utils/time';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const DRY_INITIAL_BALANCE = ENV.DRY_INITIAL_BALANCE;
const DRY_START_FROM_REAL = ENV.DRY_START_FROM_REAL;
const DOUBLE_SIDE_GUARD_MODE = ENV.COPY_DOUBLE_SIDE_GUARD_MODE;
// Match postOrder.ts: minimum sell size in outcome tokens
const MIN_ORDER_SIZE_TOKENS = 1.0;

/**
 * Fetch the opposite asset ID for a given conditionId and current asset.
 * Simplified version for dry run.
 */
const fetchOppositeAssetDryRun = async (conditionId: string, currentAsset: string): Promise<string> => {
    try {
        // Try Gamma API with condition_id
        const response = await fetchData(
            `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`
        );

        if (response && typeof response === 'object') {
            const markets = Array.isArray(response) ? response : (response.markets || response.data || []);

            for (const market of markets) {
                if (market.clobTokenIds) {
                    try {
                        const tokenIds: string[] = JSON.parse(market.clobTokenIds);
                        const opposite = tokenIds.find((id: string) => id !== currentAsset);
                        if (opposite) {
                            return opposite;
                        }
                    } catch {
                        // 解析失败
                    }
                }

                // 尝试 outcomeAssets
                if (Array.isArray(market.outcomeAssets) && market.outcomeAssets.length >= 2) {
                    const opposite = market.outcomeAssets.find((a: string) => a !== currentAsset);
                    if (opposite) {
                        return opposite;
                    }
                }
            }
        }
    } catch {
        // 忽略错误
    }

    // 通过 orderbook 获取 condition_id
    try {
        const orderbookResponse = await fetchData(
            `https://clob.polymarket.com/book?token_id=${currentAsset}`
        );

        if (orderbookResponse && typeof orderbookResponse === 'object') {
            const marketConditionId = (orderbookResponse as any).market;
            if (marketConditionId) {
                const response = await fetchData(
                    `https://gamma-api.polymarket.com/markets?condition_id=${marketConditionId}`
                );

                if (response && typeof response === 'object') {
                    const markets = Array.isArray(response) ? response : (response.markets || response.data || []);

                    for (const market of markets) {
                        if (market.clobTokenIds) {
                            try {
                                const tokenIds: string[] = JSON.parse(market.clobTokenIds);
                                const opposite = tokenIds.find((id: string) => id !== currentAsset);
                                if (opposite) {
                                    return opposite;
                                }
                            } catch {
                                // 解析失败
                            }
                        }
                    }
                }
            }
        }
    } catch {
        // 忽略错误
    }

    return '';
};

const userActivityModels = USER_ADDRESSES.map((address) => ({
    address,
    model: getUserActivityModel(address),
}));

const normalizeOutcomeForStorage = (label: string | undefined): string | undefined => {
    if (!label) return undefined;
    const trimmed = String(label).trim();
    if (!trimmed || trimmed.startsWith('未知')) return undefined;
    // 去掉补充说明，仅保留方向标签（如 Up/Down/Yes/No）
    const compact = trimmed.split('（')[0].split('(')[0].trim();
    return compact || undefined;
};

interface SimulatedPosition {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    /** 结果方向，如 Up / Down / Yes / No（来自跟单活动或 API 回补） */
    outcome?: string;
    title?: string;
    slug?: string;
    eventSlug?: string;
    openedBy?: string;
}

// Simulated position key: "conditionId:asset" to handle YES + NO sides independently
const posKey = (conditionId: string, asset: string) => `${conditionId}:${asset}`;

interface OrderBookEntry {
    price: string;
    size: string;
}

// ============================================================
// Simulated account state (in-memory, reset on restart)
// ============================================================
let simulatedBalance = DRY_INITIAL_BALANCE;
const simulatedPositions: Map<string, SimulatedPosition> = new Map();

// Historical positions loaded from Polymarket at dry-run start.
// They are used only as baseline for reporting, NOT for sell availability during this run.
const baselinePositions: Map<string, SimulatedPosition> = new Map();

// Baseline net value at dry-run start. Used to show incremental PnL.
let initialNetValue: number | null = null;

// Track processed trades to avoid re-processing
const processedIds: Set<string> = new Set();

// Only simulate trades detected after this dry-run instance started.
// This prevents MongoDB historical (old botExcutedTime=0) records from being treated as "new".
const dryRunStartTimestamp = Math.floor(Date.now() / 1000);

// Throttle noisy skip logs (per token+reason)
const noAsksLogged: Set<string> = new Set();
const noBidsLogged: Set<string> = new Set();
const orderBookMissingLogged: Set<string> = new Set();

/** 与实盘共用 POSITION_RECONCILE_* 配置；冷却按 conditionId+asset */
const dryReconcileLastAt = new Map<string, number>();
const dryReconcileOppositeCache = new Map<string, string>();

/** 与实盘共用：Data curPrice → CLOB 轻量价 → Gamma → 最后 orderbook（见 tokenMark） */
const getValuationPriceUsd = async (
    asset: string,
    clobClient: ClobClient,
    conditionId?: string
): Promise<number> => resolveTokenMarkUsd(clobClient, asset, { conditionId });

// 订单簿：与 postOrder 共用缓存（fetchOrderBookCached）
const fetchOrderBook = async (
    clobClient: ClobClient,
    asset: string
): Promise<{ bids: OrderBookEntry[]; asks: OrderBookEntry[] } | null> => {
    try {
        return await fetchOrderBookCached(clobClient, asset);
    } catch (error: unknown) {
        Logger.warning(`订单簿查询失败: ${error}`);
        return null;
    }
};

// ============================================================
// Simulate fill logic (mirrors postOrder.ts market-order logic)
// ============================================================

/**
 * 与实盘 postOrder BUY 一致：`amount` 为 USDC；订单簿 `size` 为份额；单笔消耗 USD = min(剩余, size*price)。
 */
const simulateFillBuy = (
    amountUsd: number,
    asks: OrderBookEntry[]
): { spent: number; tokens: number; avgPrice: number } => {
    let remainingUsd = amountUsd;
    let totalSpent = 0;
    let totalTokens = 0;

    const levels = [...asks]
        .map((a) => ({
            price: parseFloat(a.price),
            size: parseFloat(a.size),
        }))
        .filter((x) => isFinite(x.price) && x.price > 0 && isFinite(x.size) && x.size > 0)
        .sort((a, b) => a.price - b.price);

    for (const level of levels) {
        if (remainingUsd <= 0) break;
        const maxUsdThisLevel = level.size * level.price;
        const usdFill = Math.min(remainingUsd, maxUsdThisLevel);
        const tokenFill = usdFill / level.price;
        totalSpent += usdFill;
        totalTokens += tokenFill;
        remainingUsd -= usdFill;
    }

    return {
        spent: totalSpent,
        tokens: totalTokens,
        avgPrice: totalTokens > 0 ? totalSpent / totalTokens : 0,
    };
};

const simulateFillSell = (
    amount: number,
    bids: OrderBookEntry[]
): { proceeds: number; tokens: number; avgPrice: number } => {
    let remaining = amount;
    let totalProceeds = 0;
    let totalTokens = 0;
    for (const bid of bids) {
        if (remaining <= 0) break;
        const price = parseFloat(bid.price);
        const size = parseFloat(bid.size);
        const fill = Math.min(remaining, size);
        totalProceeds += fill * price;
        totalTokens += fill;
        remaining -= fill;
    }
    return {
        proceeds: totalProceeds,
        tokens: totalTokens,
        avgPrice: totalTokens > 0 ? totalProceeds / totalTokens : 0,
    };
};

// ============================================================
// Read pending trades from MongoDB (same query as tradeExecutor)
// ============================================================

const readPendingTrades = async () => {
    const allTrades: any[] = [];
    for (const { address, model } of userActivityModels) {
        const trades = await model
            .find({
                $and: [
                    { type: 'TRADE' },
                    { bot: true },
                    { botExcutedTime: 0 },
                    // Only process trades after this dry-run instance started
                    { timestamp: { $gte: dryRunStartTimestamp } },
                ],
            })
            .exec();
        allTrades.push(...trades.map((t) => ({ ...t.toObject(), userAddress: address })));
    }
    return allTrades;
};

// ============================================================
// Initialize simulated balance & positions from real data
// ============================================================

const initSimulatedAccount = async () => {
    console.log(`  模拟初始余额: $${DRY_INITIAL_BALANCE.toFixed(2)}`);

    if (DRY_START_FROM_REAL) {
        try {
        // Load real positions from Polymarket API
            const myPositions: any[] = (await fetchPositionsForUserForce(ENV.PROXY_WALLET)) as any[];

        if (Array.isArray(myPositions) && myPositions.length > 0) {
                console.log(`  加载真实历史持仓: ${myPositions.length} 个市场`);
            for (const pos of myPositions) {
                if (pos.size > 0) {
                    const key = posKey(pos.conditionId, pos.asset);
                        baselinePositions.set(key, {
                        asset: pos.asset,
                        conditionId: pos.conditionId,
                        size: pos.size,
                        avgPrice: pos.avgPrice || 0,
                            outcome: pos.outcome,
                        title: pos.title,
                        slug: pos.slug,
                        eventSlug: pos.eventSlug,
                    });
                }
            }
        }
            console.log(`  历史持仓: ${baselinePositions.size} 个市场`);
        } catch (err) {
            // Do not block dry-run startup on positions fetch failures.
            console.log(`  ⚠️ 加载历史持仓失败，降级为0个历史持仓：${String(err)}`);
        }
    }
};

// ============================================================
// Execute a single simulated trade
// ============================================================

const doDryTrading = async (
    clobClient: ClobClient,
    trade: any
): Promise<void> => {
    const tradeId = trade._id?.toString() || `${trade.transactionHash}-${trade.timestamp}`;
    if (processedIds.has(tradeId)) return;
    processedIds.add(tradeId);

    const copyMode = ENV.COPY_STRATEGY_CONFIG.copyMode;
    const actualSide = getActualSide(trade.side || 'BUY', copyMode);
    const isReversed = copyMode === CopyMode.REVERSE;

    // Mark as processed (botExcutedTime: 2 means "dry-run processed")
    const UserActivity = getUserActivityModel(trade.userAddress);
    await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 2 } });

    console.log('\n' + '─'.repeat(70));
    const time = formatBeijingDateTime(new Date(trade.timestamp * 1000));
    const marketName = trade.title || trade.slug || trade.asset?.slice(0, 16) || 'unknown';
    console.log(`  📊 ${time}`);
    console.log(`  市场: ${marketName}`);
    console.log(`  交易员: ${trade.userAddress?.slice(0, 6)}...${trade.userAddress?.slice(-4)}`);
    console.log(`  原始订单: ${trade.side} $${trade.usdcSize.toFixed(2)} @ $${trade.price}`);

    // Resolve token we trade (must be before BUY sizing — position limit uses this key)
    let tradeAsset = isReversed ? (trade.oppositeAsset || trade.asset) : trade.asset;

    if (isReversed && (!trade.oppositeAsset || trade.oppositeAsset === trade.asset)) {
        console.log(`  ⚠️  数据库中没有有效 oppositeAsset，尝试实时获取...`);
        const fetchedOpposite = await fetchOppositeAssetDryRun(trade.conditionId, trade.asset);
        if (fetchedOpposite && fetchedOpposite !== trade.asset) {
            console.log(`  ✅ 成功获取反向代币: ${fetchedOpposite.slice(0, 20)}...`);
            await UserActivity.updateOne(
                { _id: trade._id },
                { $set: { oppositeAsset: fetchedOpposite } }
            );
            trade.oppositeAsset = fetchedOpposite;
            tradeAsset = fetchedOpposite;
            console.log(
                `  🔄 反买模式: 交易员 ${trade.side} ${trade.asset.slice(0, 12)}... → 我 ${actualSide} ${tradeAsset.slice(0, 12)}...`
            );
        } else {
            console.log(`  ❌ 无法获取反向代币，跳过`);
            console.log('─'.repeat(70));
            return;
        }
    } else if (isReversed) {
        console.log(
            `  🔄 反买模式: 交易员 ${trade.side} ${trade.asset.slice(0, 12)}... → 我 ${actualSide} ${trade.oppositeAsset.slice(0, 12)}...`
        );
    } else {
        console.log(`  → 跟单方向: ${actualSide} (${trade.asset.slice(0, 12)}...)`);
    }

    const user_positions = (await fetchPositionsForUser(trade.userAddress)) as UserPositionInterface[];
    const userPosList = Array.isArray(user_positions) ? user_positions : [];
    const outcomeLabels = resolveCopyOutcomeLabels(copyMode, trade, userPosList);
    console.log(`  📌 交易员 Outcome: ${outcomeLabels.traderOutcome}`);
    console.log(
        `  📌 我跟单 Outcome: ${outcomeLabels.myOutcome}（${outcomeLabels.modeHint}）`
    );

    const myHoldingKey = posKey(trade.conditionId, tradeAsset);

    // 风控：同一 condition 只跟一边。若已有另一侧持仓，则忽略后续另一边 BUY，避免两头买。
    if (actualSide === 'BUY') {
        const oppositeHeld = [...simulatedPositions.values()].find(
            (p) =>
                p.conditionId === trade.conditionId &&
                p.asset !== tradeAsset &&
                p.size > 0.0001
        );
        const shouldBlock =
            DOUBLE_SIDE_GUARD_MODE !== 'OFF' &&
            !!oppositeHeld &&
            (DOUBLE_SIDE_GUARD_MODE !== 'TRADER_ONLY' ||
                !!(oppositeHeld.openedBy && oppositeHeld.openedBy === trade.userAddress));
        if (shouldBlock && oppositeHeld) {
            console.log(
                `  ⏭  跳过: 同一市场已持有另一侧 (${oppositeHeld.outcome || oppositeHeld.asset.slice(0, 12)}...)，禁止两头买入`
            );
            console.log('─'.repeat(70));
            return;
        }
    }

    // BUY: dollar sizing via calculateOrderSize. SELL: token sizing like live postOrder (do NOT use cash min $1 gate).
    let orderCalc: ReturnType<typeof calculateOrderSize> | null = null;

    if (actualSide === 'BUY') {
        await refreshCurPriceMap(false);
        const simPos = simulatedPositions.get(myHoldingKey);
        let currentPositionUsd = 0;
        if (simPos && simPos.size > 0) {
            const px = await getValuationPriceUsd(simPos.asset, clobClient, simPos.conditionId);
            currentPositionUsd = simPos.size * px;
        }

        orderCalc = calculateOrderSize(
            ENV.COPY_STRATEGY_CONFIG,
            trade.usdcSize,
            simulatedBalance,
            currentPositionUsd,
            0
        );
        console.log(`  计算跟单: $${orderCalc.finalAmount.toFixed(2)} | ${orderCalc.reason}`);
        if (orderCalc.finalAmount === 0) {
            console.log(`  ⏭  跳过: ${orderCalc.reason}`);
            console.log('─'.repeat(70));
            return;
        }
    } else {
        console.log(
            `  计算跟单: 卖出按持仓比例（代币数量，与实盘 postOrder 一致；不受现金 <$1 限制）`
        );
    }

    const orderBook = await fetchOrderBook(clobClient, tradeAsset);
    if (!orderBook) {
        const key = `missing:${tradeAsset}`;
        if (!orderBookMissingLogged.has(key)) {
            orderBookMissingLogged.add(key);
            console.log(`  ⚠️  订单簿不存在 (404)，跳过`);
        console.log('─'.repeat(70));
        }
        return;
    }

    if (actualSide === 'BUY') {
        if (!orderCalc || orderCalc.finalAmount <= 0) {
            console.log('─'.repeat(70));
            return;
        }

        if (!orderBook.asks || orderBook.asks.length === 0) {
            const key = `noAsks:${tradeAsset}`;
            if (!noAsksLogged.has(key)) {
                noAsksLogged.add(key);
            console.log(`  ⚠️  无卖单，跳过`);
            console.log('─'.repeat(70));
            }
            return;
        }

        const result = simulateFillBuy(orderCalc.finalAmount, orderBook.asks);
        if (result.tokens === 0) {
            console.log(`  ⚠️  卖单深度不足，无法成交`);
            console.log('─'.repeat(70));
            return;
        }

        console.log(
            `  ✅ 模拟买入: $${result.spent.toFixed(2)} → ${result.tokens.toFixed(4)} tokens @ $${result.avgPrice.toFixed(4)}`
        );
        console.log(`  💰 余额: $${simulatedBalance.toFixed(2)} → $${(simulatedBalance - result.spent).toFixed(2)}`);
        simulatedBalance -= result.spent;

        const existing = simulatedPositions.get(myHoldingKey);
        const oc =
            normalizeOutcomeForStorage(outcomeLabels.myOutcome) ||
            normalizeOutcomeForStorage(trade.outcome);
        if (existing) {
            const totalSize = existing.size + result.tokens;
            const totalCost = existing.size * existing.avgPrice + result.tokens * result.avgPrice;
            existing.size = totalSize;
            existing.avgPrice = totalCost / totalSize;
            if (!existing.outcome && oc) {
                existing.outcome = oc;
            }
            if (!existing.openedBy && trade.userAddress) {
                existing.openedBy = trade.userAddress;
            }
        } else {
            simulatedPositions.set(myHoldingKey, {
                asset: tradeAsset,
                conditionId: trade.conditionId,
                size: result.tokens,
                avgPrice: result.avgPrice,
                outcome: oc,
                title: trade.title,
                slug: trade.slug,
                eventSlug: trade.eventSlug,
                openedBy: trade.userAddress,
            });
        }

        const posNow = simulatedPositions.get(myHoldingKey);
        if (posNow) {
            const mark = await getValuationPriceUsd(posNow.asset, clobClient, posNow.conditionId);
            const pxUsed = mark > 0 ? mark : posNow.avgPrice;
            const unrealized = posNow.size * (pxUsed - posNow.avgPrice);
            console.log(
                `  📈 未实现盈亏(curPrice): $${unrealized >= 0 ? '+' : ''}${unrealized.toFixed(2)}`
            );
        }
    } else {
        if (!orderBook.bids || orderBook.bids.length === 0) {
            const key = `noBids:${tradeAsset}`;
            if (!noBidsLogged.has(key)) {
                noBidsLogged.add(key);
            console.log(`  ⚠️  无买单，跳过`);
            console.log('─'.repeat(70));
            }
            return;
        }

        const existing = simulatedPositions.get(myHoldingKey);
        if (!existing || existing.size <= 0) {
            console.log(`  ⚠️  无持仓可卖，跳过`);
            console.log('─'.repeat(70));
            return;
        }

        const user_position = userPosList.find(
            (p: UserPositionInterface) =>
                p.conditionId === trade.conditionId && p.asset === trade.asset
        );

        let sellTokens: number;
        if (!user_position) {
            sellTokens = existing.size;
            console.log(`  📉 交易员已清仓该方向 → 模拟卖出全部持仓 ${sellTokens.toFixed(4)} tokens`);
        } else {
            const trader_position_before = user_position.size + trade.size;
            const trader_sell_percent = trade.size / trader_position_before;
            const baseSellSize = existing.size * trader_sell_percent;
            const multiplier = getTradeMultiplier(ENV.COPY_STRATEGY_CONFIG, trade.usdcSize);
            sellTokens = baseSellSize * multiplier;
            console.log(
                `  📉 跟单卖出: 我方持仓 ${existing.size.toFixed(4)} × ${(trader_sell_percent * 100).toFixed(2)}% × ${multiplier}x → ${sellTokens.toFixed(4)} tokens`
            );
        }

        if (sellTokens > existing.size) {
            sellTokens = existing.size;
        }

        if (sellTokens < MIN_ORDER_SIZE_TOKENS) {
            console.log(
                `  ⏭  跳过: 卖出数量 ${sellTokens.toFixed(4)} 低于最小 ${MIN_ORDER_SIZE_TOKENS} tokens`
            );
            console.log('─'.repeat(70));
            return;
        }

        const result = simulateFillSell(sellTokens, orderBook.bids);
        if (result.tokens === 0) {
            console.log(`  ⚠️  买单深度不足，无法成交`);
            console.log('─'.repeat(70));
            return;
        }

        const costBasis = result.tokens * existing.avgPrice;
        const pnl = result.proceeds - costBasis;

        console.log(
            `  ✅ 模拟卖出: ${result.tokens.toFixed(4)} tokens @ $${result.avgPrice.toFixed(4)} → $${result.proceeds.toFixed(2)}`
        );
        console.log(`  💰 余额: $${simulatedBalance.toFixed(2)} → $${(simulatedBalance + result.proceeds).toFixed(2)}`);
        console.log(`  📈 已实现盈亏: $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (成本 $${costBasis.toFixed(2)})`);
        simulatedBalance += result.proceeds;

            existing.size -= result.tokens;
            if (existing.size <= 0.0001) {
                simulatedPositions.delete(myHoldingKey);
        } else {
            const mark = await getValuationPriceUsd(existing.asset, clobClient, existing.conditionId);
            const pxUsed = mark > 0 ? mark : existing.avgPrice;
            const unrealized = existing.size * (pxUsed - existing.avgPrice);
            console.log(
                `  📈 未实现盈亏(curPrice): $${unrealized >= 0 ? '+' : ''}${unrealized.toFixed(2)}`
            );
        }
    }

    await printAccountSummary(clobClient);
    console.log('─'.repeat(70));
};

// ============================================================
// Print current account snapshot
// ============================================================

const printAccountSummary = async (clobClient: ClobClient) => {
    await refreshCurPriceMap(false);
    let simulatedPositionValue = 0;
    for (const [, pos] of simulatedPositions) {
        const px = await getValuationPriceUsd(pos.asset, clobClient, pos.conditionId);
        const pxUsed = px > 0 ? px : pos.avgPrice;
        simulatedPositionValue += pos.size * pxUsed;
    }

    const currentNetValue = simulatedBalance + simulatedPositionValue;
    const deltaNetValue = initialNetValue === null ? 0 : currentNetValue - initialNetValue;
    console.log(
        `  📋 模拟账户: 余额 $${simulatedBalance.toFixed(2)} | 模拟持仓 ${simulatedPositions.size} 个 | 历史持仓 ${baselinePositions.size} 个 | 净值(含curPrice估值) $${currentNetValue.toFixed(2)} | 模拟盈亏 ${deltaNetValue >= 0 ? '+' : ''}$${deltaNetValue.toFixed(2)}`
    );
};

/**
 * 合并代理钱包 + 跟单地址的 positions：任一方 redeemable 则视为该 asset 可赎回。
 * 纯模拟时代理钱包常无仓，仅靠 PROXY 会漏掉「市场已结算」信号。
 */
const buildRedeemableByAssetMerged = async (): Promise<Map<string, boolean>> => {
    const m = new Map<string, boolean>();
    const addrs = [ENV.PROXY_WALLET, ...ENV.USER_ADDRESSES];
    const unique = [...new Set(addrs.map((a) => a.toLowerCase()))];
    for (const addr of unique) {
        try {
            const raw = await fetchPositionsForUser(addr);
            if (!Array.isArray(raw)) continue;
            for (const row of raw as { asset?: string; redeemable?: boolean }[]) {
                if (!row?.asset) continue;
                if (row.redeemable === true) {
                    m.set(row.asset, true);
                } else if (!m.has(row.asset)) {
                    m.set(row.asset, false);
                }
            }
        } catch {
            // ignore per-wallet
        }
    }
    return m;
};

type ReconcileFlattenOpts = {
    /** 已结算市场：若 CLOB 无买盘/深度不足，按结算价模拟赎回释放现金 */
    settledCashout?: boolean;
    settlementPxHint?: number;
    redeemable?: boolean;
};

/** 每份 outcome 在结算时的应付 USD（0~1），与 Polymarket 到期兑付一致 */
const resolveSettlementPxForDryRun = async (
    pos: SimulatedPosition,
    clobClient: ClobClient,
    hint: number | undefined,
    redeemable: boolean
): Promise<number> => {
    if (hint !== undefined && isFinite(hint) && hint >= 0) {
        return Math.max(0, Math.min(1, hint));
    }
    let cp = (await getCurPriceForAsset(pos.asset, true)) ?? Number.NaN;
    if (!isFinite(cp) || cp < 0) {
        const v = await getValuationPriceUsd(pos.asset, clobClient, pos.conditionId);
        if (isFinite(v) && v >= 0) {
            cp = v;
        }
    }
    if (isFinite(cp) && cp >= 0) {
        return Math.max(0, Math.min(1, cp));
    }
    return redeemable ? 1 : 0;
};

/** 模拟对账：优先 CLOB 卖出；已结算且无流动性时按结算价模拟赎回（释放模拟余额） */
const simulateReconcileFlatten = async (
    clobClient: ClobClient,
    mapKey: string,
    pos: SimulatedPosition,
    reason: string,
    opts?: ReconcileFlattenOpts
): Promise<void> => {
    const existing = simulatedPositions.get(mapKey);
    if (!existing || existing.size <= 0) return;
    // 已结算模拟赎回允许「碎股」；CLOB 对账仍要求最小可卖份额
    if (!opts?.settledCashout && existing.size < RECONCILE_MIN_SELL_TOKENS) return;

    Logger.header(`🧹 仓位对账平仓（模拟）`);
    Logger.info(`原因: ${reason}`);
    Logger.info(`市场: ${pos.title || pos.slug || pos.conditionId.slice(0, 16)}...`);
    Logger.info(
        `Outcome: ${existing.outcome || '—'} | 代币: ${pos.asset.slice(0, 14)}... | 数量: ${existing.size.toFixed(4)}`
    );

    const orderBook = await fetchOrderBook(clobClient, pos.asset);
    if (orderBook?.bids?.length) {
        const result = simulateFillSell(existing.size, orderBook.bids);
        if (result.tokens >= RECONCILE_MIN_SELL_TOKENS) {
            const costBasis = result.tokens * existing.avgPrice;
            const pnl = result.proceeds - costBasis;
            Logger.info(
                `✅ 模拟对账卖出: ${result.tokens.toFixed(4)} tok @ $${result.avgPrice.toFixed(4)} → $${result.proceeds.toFixed(2)}`
            );
            Logger.info(
                `💰 余额: $${simulatedBalance.toFixed(2)} → $${(simulatedBalance + result.proceeds).toFixed(2)} | 本笔盈亏 $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`
            );

            simulatedBalance += result.proceeds;
            existing.size -= result.tokens;
            if (existing.size <= 0.0001) {
                simulatedPositions.delete(mapKey);
            }

            await printAccountSummary(clobClient);
            return;
        }
        Logger.warning(
            `[模拟对账] CLOB 深度不足 (${result.tokens.toFixed(4)} tok)，尝试结算价平仓`
        );
    } else {
        Logger.warning('[模拟对账] 无订单簿或无买盘');
    }

    if (opts?.settledCashout && existing.size > 0) {
        const px = await resolveSettlementPxForDryRun(
            pos,
            clobClient,
            opts.settlementPxHint,
            opts.redeemable === true
        );
        const proceeds = existing.size * px;
        const costBasis = existing.size * existing.avgPrice;
        const pnl = proceeds - costBasis;
        Logger.info(
            `✅ 模拟结算平仓（已 Resolved / 无盘口流动性）: ${existing.size.toFixed(4)} 份 × $${px.toFixed(4)}/份 → $${proceeds.toFixed(2)}`
        );
        Logger.info(
            `💰 余额: $${simulatedBalance.toFixed(2)} → $${(simulatedBalance + proceeds).toFixed(2)} | 本笔盈亏 $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`
        );
        simulatedBalance += proceeds;
        simulatedPositions.delete(mapKey);
        await printAccountSummary(clobClient);
        return;
    }

    Logger.warning(
        '[模拟对账] 非结算路径或无结算参数：无法平仓；已结算时请确认 POSITION_RECONCILE_ON_RESOLVED=true'
    );
};

/**
 * Dry run 周期性对账：与实盘 `runPositionReconciliation` 同一套 env 与判定（镜像腿 / 已结算），
 * 仅将平仓改为订单簿模拟成交，不发送链上交易；AUTO_REDEEM 仅打日志说明。
 */
const runDryRunPositionReconciliation = async (clobClient: ClobClient): Promise<void> => {
    const interval = ENV.POSITION_RECONCILE_INTERVAL_MS;
    if (!interval || interval <= 0) return;

    const copiedMap = await loadCopiedConditionTraders();
    if (copiedMap.size === 0) return;

    const maxPerRun = ENV.POSITION_RECONCILE_MAX_PER_RUN;
    const cooldownMs = ENV.POSITION_RECONCILE_COOLDOWN_MS;
    const onTraderExit = ENV.POSITION_RECONCILE_ON_TRADER_EXIT;
    const onResolved = ENV.POSITION_RECONCILE_ON_RESOLVED;
    const autoRedeem = ENV.POSITION_RECONCILE_AUTO_REDEEM;

    const redeemableByAsset = await buildRedeemableByAssetMerged();
    await refreshCurPriceMap(true);

    const traderPosCache = new Map<string, UserPositionInterface[]>();
    const redeemHintLogged = new Set<string>();
    let actions = 0;
    const now = Date.now();
    const copyMode = ENV.COPY_STRATEGY_CONFIG.copyMode;

    const entries = [...simulatedPositions.entries()];
    for (const [mapKey, pos] of entries) {
        if (actions >= maxPerRun) break;
        if (pos.size <= 0) continue;

        const involved = copiedMap.get(pos.conditionId);
        if (!involved?.size) continue;

        const pkey = positionKey(pos.conditionId, pos.asset);
        const lastAt = dryReconcileLastAt.get(pkey) || 0;
        if (now - lastAt < cooldownMs) continue;

        let oppositeForMirror: string | undefined;
        if (copyMode === CopyMode.REVERSE) {
            const cacheK = `${pos.conditionId}:${pos.asset}`;
            oppositeForMirror = dryReconcileOppositeCache.get(cacheK);
            if (!oppositeForMirror) {
                oppositeForMirror = await fetchOppositeAssetDryRun(pos.conditionId, pos.asset);
                if (oppositeForMirror) {
                    dryReconcileOppositeCache.set(cacheK, oppositeForMirror);
                }
            }
        }

        const mirrorAsset = getMirrorAssetForReconcile(copyMode, pos.asset, oppositeForMirror);
        if (!mirrorAsset) {
            Logger.warning(`[模拟对账] 跳过 ${pkey}: 反买模式但缺少 oppositeAsset`);
            continue;
        }

        let curPrice = (await getCurPriceForAsset(pos.asset, true)) ?? Number.NaN;
        if (!isFinite(curPrice) || curPrice < 0) {
            const v = await getValuationPriceUsd(pos.asset, clobClient, pos.conditionId);
            if (isFinite(v) && v >= 0) {
                curPrice = v;
            }
        }

        const redeemable = redeemableByAsset.get(pos.asset) === true;
        const gammaInfo = await fetchGammaSettlementInfoCached(pos.conditionId);
        const gammaHit = gammaTokenLooksSettled(gammaInfo, pos.asset);

        const resolvedByApi = isMarketResolved(
            isFinite(curPrice) ? curPrice : Number.NaN,
            redeemable
        );
        const resolved = resolvedByApi || gammaHit.settled;

        let settlementPxHint: number | undefined;
        if (gammaHit.settled && gammaHit.settlementPx !== undefined) {
            settlementPxHint = gammaHit.settlementPx;
        } else if (
            isFinite(curPrice) &&
            (curPrice >= RESOLVED_HIGH || curPrice <= RESOLVED_LOW)
        ) {
            settlementPxHint = curPrice;
        }

        let handled = false;

        // 已结算优先：不受 RECONCILE_MIN_SELL_TOKENS 限制，避免 Resolved 后碎股仍占仓
        if (onResolved && resolved) {
            const reasonGamma = gammaHit.settled
                ? `Gamma: 市场已关闭且 outcome 价≈0/1 (结算 $${gammaHit.settlementPx?.toFixed(4) ?? 'n/a'}/份)`
                : '';
            const reasonApi = redeemable
                ? '市场已结算/可赎回 (Data API 或合并钱包 positions)'
                : `市场结果已明朗 (curPrice≈${isFinite(curPrice) ? curPrice.toFixed(4) : 'n/a'})`;
            await simulateReconcileFlatten(
                clobClient,
                mapKey,
                pos,
                gammaHit.settled ? reasonGamma : reasonApi,
                {
                    settledCashout: true,
                    settlementPxHint,
                    redeemable,
                }
            );
            dryReconcileLastAt.set(pkey, Date.now());
            actions += 1;
            handled = true;

            if (
                autoRedeem &&
                redeemable &&
                !redeemHintLogged.has(pos.conditionId)
            ) {
                redeemHintLogged.add(pos.conditionId);
                Logger.info(
                    '[模拟对账] POSITION_RECONCILE_AUTO_REDEEM=true：实盘将尝试链上 redeem；模拟不发送交易'
                );
            }
        }

        if (handled) continue;

        if (pos.size < RECONCILE_MIN_SELL_TOKENS) continue;

        if (onTraderExit) {
            const stillIn = await anyTraderStillInMirror(
                involved,
                pos.conditionId,
                mirrorAsset,
                traderPosCache
            );
            if (!stillIn) {
                await simulateReconcileFlatten(
                    clobClient,
                    mapKey,
                    pos,
                    '跟单钱包镜像腿已平（与实盘对账规则一致）'
                );
                dryReconcileLastAt.set(pkey, Date.now());
                actions += 1;
            }
        }
    }
};

/** 从代理钱包 + 跟单地址的 positions 回补 outcome 文案（模拟仓未必在链上） */
const buildAssetOutcomeLookup = async (): Promise<Map<string, string>> => {
    const m = new Map<string, string>();
    const addrs = [ENV.PROXY_WALLET, ...ENV.USER_ADDRESSES];
    const unique = [...new Set(addrs.map((a) => a.toLowerCase()))];
    for (const addr of unique) {
        try {
            const raw = await fetchPositionsForUser(addr);
            if (!Array.isArray(raw)) continue;
            for (const row of raw as { asset?: string; outcome?: string }[]) {
                if (row?.asset && row.outcome != null && String(row.outcome).trim()) {
                    m.set(row.asset, String(row.outcome).trim());
                }
            }
        } catch {
            // ignore
        }
    }
    return m;
};

const printSimulatedPositionsSnapshot = async (clobClient: ClobClient) => {
    if (simulatedPositions.size === 0) {
        return;
    }
    const outcomeLookup = await buildAssetOutcomeLookup();
    console.log('\n  ' + '═'.repeat(66));
    console.log(
        '  📌 模拟持仓明细（Outcome | 估值: Data curPrice → CLOB 轻量价 → Gamma 收盘 → 订单簿；Outcome 来自跟单或 API）'
    );
    let totalMkt = 0;
    for (const [, pos] of simulatedPositions) {
        const px = await getValuationPriceUsd(pos.asset, clobClient, pos.conditionId);
        const pxUsed = px > 0 ? px : pos.avgPrice;
        const mv = pos.size * pxUsed;
        totalMkt += mv;
        const title = (pos.title || pos.slug || pos.asset).slice(0, 36);
        const oc = pos.outcome || outcomeLookup.get(pos.asset) || '—';
        console.log(
            `  • ${title} | Outcome: ${oc} | ${pos.size.toFixed(4)} tok | ~$${pxUsed.toFixed(4)}/tok | 市值~$${mv.toFixed(2)} | 成本 $${pos.avgPrice.toFixed(4)}`
        );
    }
    console.log(`  📎 持仓市值合计 ~$${totalMkt.toFixed(2)} | 现金 $${simulatedBalance.toFixed(2)}`);
    console.log('  ' + '═'.repeat(66) + '\n');
};

// ============================================================
// Main executor loop
// ============================================================

let isRunning = true;

export const stopDryRunExecutor = () => {
    isRunning = false;
    Logger.info('模拟跟单已请求关闭...');
};

const dryRunExecutor = async (clobClient: ClobClient) => {
    console.log('\n');
    console.log('\x1b[35m' + '  ____     ___                   ____            _     __  __                                          ');
    console.log('\x1b[35m' + ' |  _ \\   / _ \\ _ __   ___ _ __ |  _ \\ _   _  ___| | _|  \\/  | __ _ _ __   __ _  __ _  ___ _ __ ');
    console.log("\x1b[35m" + " | | | | | | | | '_ \\ / _ \\ '_ \\| |_) | | | |/ __| |/ / |\\/| |/ _` | '_ \\ / _` |/ _` |/ _ \\ '__|");
    console.log('\x1b[35m' + ' | |_| | | |_| | |_) |  __/ | | |  _ <| |_| | (__|   <| |  | | (_| | | | | (_| | (_| |  __/ |   ');
    console.log('\x1b[35m' + ' |____/   \\___/| .__/ \\___|_| |_|_| \\_\\\\__,_|\\___|_|\\_\\_|  |_|\\__,_|_| |_|\\__, |\\__, |\\___|_|   ');
    console.log('\x1b[35m' + '                 |_|                                                        |___/ |___/            ');
    console.log('\x1b[33m' + '                    模拟跟单 · 实时监控 · 不执行真实交易\n');

    console.log('  ⚙️  模拟配置:');
    console.log(`    跟单模式:     ${ENV.COPY_STRATEGY_CONFIG.copyMode === CopyMode.REVERSE ? '反买 (REVERSE)' : '跟方向 (FOLLOW)'}`);
    console.log(`    跟单策略:     ${ENV.COPY_STRATEGY_CONFIG.strategy}`);
    console.log(`    跟单比例:     ${ENV.COPY_STRATEGY_CONFIG.copySize}%`);
    console.log(`    最大单笔:     $${ENV.COPY_STRATEGY_CONFIG.maxOrderSizeUSD}`);
    console.log(`    最小单笔:     $${ENV.COPY_STRATEGY_CONFIG.minOrderSizeUSD}`);
    console.log(`    初始模拟余额: $${DRY_INITIAL_BALANCE.toFixed(2)}`);
    console.log(`    从真实持仓开始: ${DRY_START_FROM_REAL ? '是' : '否'}`);
    console.log(`    监控交易员:   ${USER_ADDRESSES.length} 个`);
    if (ENV.POSITION_RECONCILE_INTERVAL_MS > 0) {
        console.log(
            `    仓位对账:     已启用（每 ${ENV.POSITION_RECONCILE_INTERVAL_MS}ms，与实盘同一套 POSITION_RECONCILE_*）`
        );
    } else {
        console.log(`    仓位对账:     关闭（设置 POSITION_RECONCILE_INTERVAL_MS>0 与实盘对齐）`);
    }
    console.log('');

    simulatedBalance = DRY_INITIAL_BALANCE;
    simulatedPositions.clear();
    baselinePositions.clear();
    processedIds.clear();
    dryReconcileLastAt.clear();
    dryReconcileOppositeCache.clear();

    await initSimulatedAccount();

    // Baseline for PnL: starting cash (simulated positions empty at cold start).
    // Valuation thereafter uses curPrice (+ orderbook fallback) in printAccountSummary.
    initialNetValue = simulatedBalance;

    console.log('');
    console.log('  ▶️  模拟跟单监控已启动，等待交易员新交易...\n');
    Logger.separator();

    let lastCheck = Date.now();
    let lastPositionsSnapshotAt = 0;
    let lastPositionReconcileAt = 0;
    const snapshotIntervalMs = ENV.DRY_POSITIONS_SNAPSHOT_INTERVAL_MS ?? 0;

    while (isRunning) {
        try {
            const trades = await readPendingTrades();

            if (trades.length > 0) {
                Logger.clearLine();
                Logger.info(`📥 检测到 ${trades.length} 笔待模拟交易`);
                const maxTradesPerRun = ENV.DRY_MAX_TRADES_PER_RUN ?? 20;
                const selectedTrades = trades.slice(0, maxTradesPerRun);
                if (trades.length > selectedTrades.length) {
                    Logger.info(`⏳ 本轮仅处理前 ${selectedTrades.length} 笔（其余 ${trades.length - selectedTrades.length} 笔下轮继续）`);
                }
                for (const trade of selectedTrades) {
                    await doDryTrading(clobClient, trade);
                }
                lastCheck = Date.now();
            } else {
                if (Date.now() - lastCheck > 5000) {
                    const snapHint =
                        snapshotIntervalMs > 0
                            ? `（约每 ${snapshotIntervalMs / 1000}s 打印持仓明细）`
                            : '';
                    Logger.waiting(
                        USER_ADDRESSES.length,
                        `余额 $${simulatedBalance.toFixed(2)} | 模拟持仓 ${simulatedPositions.size} 个${snapHint}`
                    );
                    if (
                        snapshotIntervalMs > 0 &&
                        simulatedPositions.size > 0 &&
                        Date.now() - lastPositionsSnapshotAt >= snapshotIntervalMs
                    ) {
                        lastPositionsSnapshotAt = Date.now();
                        await printSimulatedPositionsSnapshot(clobClient);
                    }
                    lastCheck = Date.now();
                }
            }
        } catch (error) {
            Logger.error(`模拟执行出错: ${error}`);
        }

        if (!isRunning) break;

        const reconcileMs = ENV.POSITION_RECONCILE_INTERVAL_MS;
        if (reconcileMs > 0) {
            const now = Date.now();
            if (now - lastPositionReconcileAt >= reconcileMs) {
                lastPositionReconcileAt = now;
                try {
                    await runDryRunPositionReconciliation(clobClient);
                } catch (reconcileErr) {
                    Logger.error(`模拟仓位对账失败: ${reconcileErr}`);
                }
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await printAccountSummary(clobClient);
    Logger.info('模拟跟单已停止');
};

export default dryRunExecutor;
