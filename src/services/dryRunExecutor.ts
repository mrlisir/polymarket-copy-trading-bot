import { ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import { CopyMode, getActualSide, calculateOrderSize } from '../config/copyStrategy';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const DRY_INITIAL_BALANCE = ENV.DRY_INITIAL_BALANCE;
const DRY_START_FROM_REAL = ENV.DRY_START_FROM_REAL;

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

interface SimulatedPosition {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    title?: string;
    slug?: string;
    eventSlug?: string;
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

// Track processed trades to avoid re-processing
const processedIds: Set<string> = new Set();

// ============================================================
// Orderbook query
// ============================================================

const fetchOrderBook = async (
    clobClient: ClobClient,
    asset: string
): Promise<{ bids: OrderBookEntry[]; asks: OrderBookEntry[] } | null> => {
    let retry = 0;
    while (retry < RETRY_LIMIT) {
        try {
            const orderBook = await (clobClient as any).getOrderBook(asset);
            return orderBook;
        } catch (error: any) {
            const status = error?.response?.status;
            if (status === 404) return null;
            retry++;
            Logger.warning(`订单簿查询失败 (${retry}/${RETRY_LIMIT}): ${error}`);
        }
    }
    return null;
};

// ============================================================
// Simulate fill logic (mirrors postOrder.ts market-order logic)
// ============================================================

const simulateFillBuy = (
    amount: number,
    asks: OrderBookEntry[]
): { spent: number; tokens: number; avgPrice: number } => {
    let remaining = amount;
    let totalSpent = 0;
    let totalTokens = 0;
    for (const ask of asks) {
        if (remaining <= 0) break;
        const price = parseFloat(ask.price);
        const size = parseFloat(ask.size);
        const fill = Math.min(remaining, size);
        totalSpent += fill * price;
        totalTokens += fill;
        remaining -= fill;
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
            .find({ $and: [{ type: 'TRADE' }, { bot: true }, { botExcutedTime: 0 }] })
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
        // Load real positions from Polymarket API
        const myPositions: any[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`
        );
        if (Array.isArray(myPositions) && myPositions.length > 0) {
            console.log(`  加载真实持仓: ${myPositions.length} 个市场`);
            for (const pos of myPositions) {
                if (pos.size > 0) {
                    const key = posKey(pos.conditionId, pos.asset);
                    simulatedPositions.set(key, {
                        asset: pos.asset,
                        conditionId: pos.conditionId,
                        size: pos.size,
                        avgPrice: pos.avgPrice || 0,
                        title: pos.title,
                        slug: pos.slug,
                        eventSlug: pos.eventSlug,
                    });
                }
            }
        }
        console.log(`  模拟初始持仓: ${simulatedPositions.size} 个市场`);
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

    // Calculate order size using the same strategy config
    const orderCalc = calculateOrderSize(
        ENV.COPY_STRATEGY_CONFIG,
        trade.usdcSize,
        simulatedBalance,
        0,
        0
    );

    console.log('\n' + '─'.repeat(70));
    const time = new Date(trade.timestamp * 1000).toLocaleString();
    const marketName = trade.title || trade.slug || trade.asset?.slice(0, 16) || 'unknown';
    console.log(`  📊 ${time}`);
    console.log(`  市场: ${marketName}`);
    console.log(`  交易员: ${trade.userAddress?.slice(0, 6)}...${trade.userAddress?.slice(-4)}`);
    console.log(`  原始订单: ${trade.side} $${trade.usdcSize.toFixed(2)} @ $${trade.price}`);

    console.log(`  计算跟单: $${orderCalc.finalAmount.toFixed(2)} | ${orderCalc.reason}`);

    if (orderCalc.finalAmount === 0) {
        console.log(`  ⏭  跳过: ${orderCalc.reason}`);
        console.log('─'.repeat(70));
        return;
    }

    // REVERSE mode: trade oppositeAsset, same direction as trader
    // FOLLOW mode: trade same asset as trader, same direction
    // REVERSE: Trader BUY UP → we BUY DOWN (oppositeAsset, same direction)
    //          Trader SELL UP → we SELL DOWN (oppositeAsset, same direction)
    let tradeAsset = isReversed ? (trade.oppositeAsset || trade.asset) : trade.asset;

    // 如果是 REVERSE 模式但没有 oppositeAsset（或 oppositeAsset 与原 tokenId 一样），尝试获取
    if (isReversed && (!trade.oppositeAsset || trade.oppositeAsset === trade.asset)) {
        console.log(`  ⚠️  数据库中没有有效 oppositeAsset，尝试实时获取...`);
        const fetchedOpposite = await fetchOppositeAssetDryRun(trade.conditionId, trade.asset);
        if (fetchedOpposite && fetchedOpposite !== trade.asset) {
            console.log(`  ✅ 成功获取反向代币: ${fetchedOpposite.slice(0, 20)}...`);
            // 更新数据库中的记录
            await UserActivity.updateOne(
                { _id: trade._id },
                { $set: { oppositeAsset: fetchedOpposite } }
            );
            // 重新设置目标资产（后续订单簿查询/持仓更新都要用这个 tokenId）
            tradeAsset = fetchedOpposite;
            console.log(`  🔄 反买模式: 交易员 ${trade.side} ${trade.asset.slice(0, 12)}... → 我 ${actualSide} ${tradeAsset.slice(0, 12)}...`);
        } else {
            console.log(`  ❌ 无法获取反向代币，跳过`);
            console.log('─'.repeat(70));
            return;
        }
    } else if (isReversed) {
        console.log(`  🔄 反买模式: 交易员 ${trade.side} ${trade.asset.slice(0, 12)}... → 我 ${actualSide} ${trade.oppositeAsset.slice(0, 12)}...`);
    } else {
        console.log(`  → 跟单方向: ${actualSide} (${trade.asset.slice(0, 12)}...)`);
    }

    const myHoldingKey = posKey(trade.conditionId, tradeAsset);

    // Query real orderbook for the token we actually trade
    const orderBook = await fetchOrderBook(clobClient, tradeAsset);
    if (!orderBook) {
        console.log(`  ⚠️  订单簿不存在 (404: ${tradeAsset})，跳过`);
        console.log('─'.repeat(70));
        return;
    }

    if (actualSide === 'BUY') {
        // BUY: use asks (sell side of orderbook) — buy tokens at sellers' prices
        if (!orderBook.asks || orderBook.asks.length === 0) {
            console.log(`  ⚠️  无卖单，跳过`);
            console.log('─'.repeat(70));
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

        // Update position for the token we bought
        const existing = simulatedPositions.get(myHoldingKey);
        if (existing) {
            const totalSize = existing.size + result.tokens;
            const totalCost = existing.size * existing.avgPrice + result.tokens * result.avgPrice;
            existing.size = totalSize;
            existing.avgPrice = totalCost / totalSize;
        } else {
            simulatedPositions.set(myHoldingKey, {
                asset: tradeAsset,
                conditionId: trade.conditionId,
                size: result.tokens,
                avgPrice: result.avgPrice,
                title: trade.title,
                slug: trade.slug,
                eventSlug: trade.eventSlug,
            });
        }
    } else {
        // SELL: use bids (buy side of orderbook) — sell tokens at buyers' prices
        if (!orderBook.bids || orderBook.bids.length === 0) {
            console.log(`  ⚠️  无买单，跳过`);
            console.log('─'.repeat(70));
            return;
        }

        const existing = simulatedPositions.get(myHoldingKey);
        const availableTokens = existing?.size || 0;

        const sellTokens = Math.min(orderCalc.finalAmount, availableTokens);
        if (sellTokens <= 0) {
            console.log(`  ⚠️  无持仓可卖，跳过`);
            console.log('─'.repeat(70));
            return;
        }

        const result = simulateFillSell(sellTokens, orderBook.bids);
        if (result.tokens === 0) {
            console.log(`  ⚠️  买单深度不足，无法成交`);
            console.log('─'.repeat(70));
            return;
        }

        const costBasis = result.tokens * (existing?.avgPrice || 0);
        const pnl = result.proceeds - costBasis;

        console.log(
            `  ✅ 模拟卖出: ${result.tokens.toFixed(4)} tokens @ $${result.avgPrice.toFixed(4)} → $${result.proceeds.toFixed(2)}`
        );
        console.log(`  💰 余额: $${simulatedBalance.toFixed(2)} → $${(simulatedBalance + result.proceeds).toFixed(2)}`);
        if (existing) {
            console.log(
                `  📈 盈亏: $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (成本 $${costBasis.toFixed(2)})`
            );
        }
        simulatedBalance += result.proceeds;

        // Update position
        if (existing) {
            existing.size -= result.tokens;
            if (existing.size <= 0.0001) {
                simulatedPositions.delete(myHoldingKey);
            }
        }
    }

    printAccountSummary();
    console.log('─'.repeat(70));
};

// ============================================================
// Print current account snapshot
// ============================================================

const printAccountSummary = () => {
    let positionValue = 0;
    for (const [_, pos] of simulatedPositions) {
        positionValue += pos.size * pos.avgPrice;
    }
    console.log(
        `  📋 模拟账户: 余额 $${simulatedBalance.toFixed(2)} | 持仓 ${simulatedPositions.size} 个 | 净值 $${(simulatedBalance + positionValue).toFixed(2)}`
    );
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
    console.log('');

    simulatedBalance = DRY_INITIAL_BALANCE;
    simulatedPositions.clear();
    processedIds.clear();

    await initSimulatedAccount();

    console.log('');
    console.log('  ▶️  模拟跟单监控已启动，等待交易员新交易...\n');
    Logger.separator();

    let lastCheck = Date.now();

    while (isRunning) {
        try {
            const trades = await readPendingTrades();

            if (trades.length > 0) {
                Logger.clearLine();
                Logger.info(`📥 检测到 ${trades.length} 笔待模拟交易`);
                for (const trade of trades) {
                    await doDryTrading(clobClient, trade);
                }
                lastCheck = Date.now();
            } else {
                if (Date.now() - lastCheck > 5000) {
                    Logger.waiting(USER_ADDRESSES.length, `余额 $${simulatedBalance.toFixed(2)} | 持仓 ${simulatedPositions.size} 个`);
                    lastCheck = Date.now();
                }
            }
        } catch (error) {
            Logger.error(`模拟执行出错: ${error}`);
        }

        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    printAccountSummary();
    Logger.info('模拟跟单已停止');
};

export default dryRunExecutor;
