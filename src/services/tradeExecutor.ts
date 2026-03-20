import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getTradeMultiplier, getActualSide, CopyMode } from '../config/copyStrategy';
import { getUserActivityModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import getMyBalance from '../utils/getMyBalance';
import postOrder from '../utils/postOrder';
import Logger from '../utils/logger';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const PROXY_WALLET = ENV.PROXY_WALLET;
const TRADE_AGGREGATION_ENABLED = ENV.TRADE_AGGREGATION_ENABLED;
const TRADE_AGGREGATION_WINDOW_SECONDS = ENV.TRADE_AGGREGATION_WINDOW_SECONDS;
const TRADE_AGGREGATION_MIN_TOTAL_USD = 1.0; // Polymarket minimum

// Create activity models for each user
const userActivityModels = USER_ADDRESSES.map((address) => ({
    address,
    model: getUserActivityModel(address),
}));

interface TradeWithUser extends UserActivityInterface {
    userAddress: string;
}

interface AggregatedTrade {
    userAddress: string;
    conditionId: string;
    asset: string;
    side: string;
    slug?: string;
    eventSlug?: string;
    trades: TradeWithUser[];
    totalUsdcSize: number;
    averagePrice: number;
    firstTradeTime: number;
    lastTradeTime: number;
}

// Buffer for aggregating trades
const tradeAggregationBuffer: Map<string, AggregatedTrade> = new Map();

const readTempTrades = async (): Promise<TradeWithUser[]> => {
    const allTrades: TradeWithUser[] = [];

    for (const { address, model } of userActivityModels) {
        // Only get trades that have been claimed by the monitor (bot: true AND botExcutedTime: 0)
        // The monitor sets bot: true when it first sees a new trade, preventing duplicate detection
        const trades = await model
            .find({
                $and: [{ type: 'TRADE' }, { bot: true }, { botExcutedTime: 0 }],
            })
            .exec();

        const tradesWithUser = trades.map((trade) => ({
            ...(trade.toObject() as UserActivityInterface),
            userAddress: address,
        }));

        allTrades.push(...tradesWithUser);
    }

    return allTrades;
};

/**
 * Generate a unique key for trade aggregation based on user, market, side
 */
const getAggregationKey = (trade: TradeWithUser): string => {
    return `${trade.userAddress}:${trade.conditionId}:${trade.asset}:${trade.side}`;
};

/**
 * Add trade to aggregation buffer or update existing aggregation
 */
const addToAggregationBuffer = (trade: TradeWithUser): void => {
    const key = getAggregationKey(trade);
    const existing = tradeAggregationBuffer.get(key);
    const now = Date.now();

    if (existing) {
        // Update existing aggregation
        existing.trades.push(trade);
        existing.totalUsdcSize += trade.usdcSize;
        // Recalculate weighted average price
        const totalValue = existing.trades.reduce((sum, t) => sum + t.usdcSize * t.price, 0);
        existing.averagePrice = totalValue / existing.totalUsdcSize;
        existing.lastTradeTime = now;
    } else {
        // Create new aggregation
        tradeAggregationBuffer.set(key, {
            userAddress: trade.userAddress,
            conditionId: trade.conditionId,
            asset: trade.asset,
            side: trade.side || 'BUY',
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            trades: [trade],
            totalUsdcSize: trade.usdcSize,
            averagePrice: trade.price,
            firstTradeTime: now,
            lastTradeTime: now,
        });
    }
};

/**
 * Check buffer and return ready aggregated trades
 * Trades are ready if:
 * 1. Total size >= minimum AND
 * 2. Time window has passed since first trade
 */
const getReadyAggregatedTrades = (): AggregatedTrade[] => {
    const ready: AggregatedTrade[] = [];
    const now = Date.now();
    const windowMs = TRADE_AGGREGATION_WINDOW_SECONDS * 1000;

    for (const [key, agg] of tradeAggregationBuffer.entries()) {
        const timeElapsed = now - agg.firstTradeTime;

        // Check if aggregation is ready
        if (timeElapsed >= windowMs) {
            if (agg.totalUsdcSize >= TRADE_AGGREGATION_MIN_TOTAL_USD) {
                // Aggregation meets minimum and window passed - ready to execute
                ready.push(agg);
            } else {
                // Window passed but total too small - mark individual trades as skipped
                Logger.info(
                    `${agg.userAddress} 在 ${agg.slug || agg.asset} 上的聚合交易: $${agg.totalUsdcSize.toFixed(2)} (共 ${agg.trades.length} 笔)，总额低于最低限制 ($${TRADE_AGGREGATION_MIN_TOTAL_USD}) — 跳过`
                );

                // Mark all trades in this aggregation as processed (bot: true)
                for (const trade of agg.trades) {
                    const UserActivity = getUserActivityModel(trade.userAddress);
                    UserActivity.updateOne({ _id: trade._id }, { bot: true }).exec();
                }
            }
            // Remove from buffer either way
            tradeAggregationBuffer.delete(key);
        }
    }

    return ready;
};

const doTrading = async (clobClient: ClobClient, trades: TradeWithUser[]) => {
    for (const trade of trades) {
        // Mark trade as being processed immediately to prevent duplicate processing
        const UserActivity = getUserActivityModel(trade.userAddress);
        await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 1 } });

        const actualSide = getActualSide(trade.side || 'BUY', ENV.COPY_STRATEGY_CONFIG.copyMode);

        if (ENV.COPY_STRATEGY_CONFIG.copyMode === CopyMode.REVERSE) {
            const ourAsset = trade.oppositeAsset || trade.asset;
            Logger.info(`🔄 反买模式: 交易员 ${trade.side} ${trade.asset.slice(0, 12)}... → 我 ${actualSide} ${ourAsset.slice(0, 12)}...`);
        }

        Logger.trade(trade.userAddress, actualSide, {
            asset: trade.asset, // Always use the same asset
            side: trade.side,
            amount: trade.usdcSize,
            price: trade.price,
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            transactionHash: trade.transactionHash,
        });

        const my_positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
        );
        const user_positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${trade.userAddress}`
        );

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
        const user_position = user_positions.find(
            (position: UserPositionInterface) => position.conditionId === trade.conditionId
        );

        // Get USDC balance
        const my_balance = await getMyBalance(PROXY_WALLET);

        // Calculate trader's total portfolio value from positions
        const user_balance = user_positions.reduce((total, pos) => {
            return total + (pos.currentValue || 0);
        }, 0);

        Logger.balance(my_balance, user_balance, trade.userAddress);

        // Check daily volume status before trading
        const dailyVol = getDailyVolume();
        const dailyLimit = ENV.COPY_STRATEGY_CONFIG.maxDailyVolumeUSD;
        if (dailyLimit) {
            Logger.info(
                `📊 今日交易量: $${dailyVol.toFixed(2)} / $${dailyLimit.toFixed(2)} (剩余: $${(dailyLimit - dailyVol).toFixed(2)})`
            );
        }

        // Execute the trade (use actualSide to determine buy/sell direction)
        const executedUsdc = await postOrder(
            clobClient,
            actualSide === 'BUY' ? 'buy' : 'sell',
            my_position,
            user_position,
            trade,
            my_balance,
            user_balance,
            trade.userAddress,
            dailyVol
        );

        // Track daily volume after successful trade
        if (executedUsdc > 0) {
            addDailyVolume(executedUsdc);
            Logger.info(`📈 今日累计交易量: $${getDailyVolume().toFixed(2)}`);
        }

        Logger.separator();
    }
};

/**
 * Execute aggregated trades
 */
const doAggregatedTrading = async (clobClient: ClobClient, aggregatedTrades: AggregatedTrade[]) => {
    for (const agg of aggregatedTrades) {
        Logger.header(`📊 聚合交易 (合并 ${agg.trades.length} 笔)`);
        Logger.info(`市场: ${agg.slug || agg.asset}`);
        Logger.info(`方向: ${agg.side}`);
        Logger.info(`总金额: $${agg.totalUsdcSize.toFixed(2)}`);
        Logger.info(`平均价格: $${agg.averagePrice.toFixed(4)}`);

        // Mark all individual trades as being processed
        for (const trade of agg.trades) {
            const UserActivity = getUserActivityModel(trade.userAddress);
            await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 1 } });
        }

        const my_positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
        );
        const user_positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${agg.userAddress}`
        );

        // In REVERSE mode, find position on opposite side (we hold opposite tokens to trader)
        // In FOLLOW mode, find position on same side as trader
        let my_position = my_positions.find((position: UserPositionInterface) => {
            if (ENV.COPY_STRATEGY_CONFIG.copyMode === CopyMode.REVERSE) {
                // REVERSE: match oppositeAsset to our position asset
                return position.conditionId === agg.conditionId && position.asset === agg.trades[0].oppositeAsset;
            }
            // FOLLOW: match same asset as trader
            return position.conditionId === agg.conditionId && position.asset === agg.asset;
        });
        const user_position = user_positions.find(
            (position: UserPositionInterface) => position.conditionId === agg.conditionId
        );

        // Get USDC balance
        const my_balance = await getMyBalance(PROXY_WALLET);

        // Calculate trader's total portfolio value from positions
        const user_balance = user_positions.reduce((total, pos) => {
            return total + (pos.currentValue || 0);
        }, 0);

        Logger.balance(my_balance, user_balance, agg.userAddress);

        // Check daily volume status before trading
        const dailyVol = getDailyVolume();
        const dailyLimit = ENV.COPY_STRATEGY_CONFIG.maxDailyVolumeUSD;
        if (dailyLimit) {
            Logger.info(
                `📊 今日交易量: $${dailyVol.toFixed(2)} / $${dailyLimit.toFixed(2)} (剩余: $${(dailyLimit - dailyVol).toFixed(2)})`
            );
        }

        // Create a synthetic trade object for postOrder using aggregated values
        const actualSide = getActualSide(agg.side as string, ENV.COPY_STRATEGY_CONFIG.copyMode);
        const syntheticTrade: UserActivityInterface = {
            ...agg.trades[0], // Use first trade as template
            usdcSize: agg.totalUsdcSize,
            price: agg.averagePrice,
            side: agg.side as 'BUY' | 'SELL', // Market-side direction for history queries
        };

        if (ENV.COPY_STRATEGY_CONFIG.copyMode === CopyMode.REVERSE) {
            const ourAsset = (agg.trades[0].oppositeAsset || agg.asset).slice(0, 12);
            Logger.info(`🔄 反买模式: 交易员 ${agg.side} ${agg.asset.slice(0, 12)}... → 我 ${actualSide} ${ourAsset}...`);
        }

        // Execute the aggregated trade
        const executedUsdc = await postOrder(
            clobClient,
            actualSide === 'BUY' ? 'buy' : 'sell',
            my_position,
            user_position,
            syntheticTrade,
            my_balance,
            user_balance,
            agg.userAddress,
            dailyVol
        );

        // Track daily volume after successful trade
        if (executedUsdc > 0) {
            addDailyVolume(executedUsdc);
            Logger.info(`📈 今日累计交易量: $${getDailyVolume().toFixed(2)}`);
        }

        Logger.separator();
    }
};

// Track executed volume in memory (resets at midnight UTC)
// Key: "YYYY-MM-DD", Value: total USD volume executed today
const dailyVolumeCache: Map<string, number> = new Map();

/**
 * Get today's UTC date string (YYYY-MM-DD)
 */
const getTodayKey = (): string => {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
};

/**
 * Get current daily volume
 */
export const getDailyVolume = (): number => {
    const today = getTodayKey();
    return dailyVolumeCache.get(today) || 0;
};

/**
 * Add to daily volume and return updated total
 */
export const addDailyVolume = (amount: number): number => {
    const today = getTodayKey();
    const current = dailyVolumeCache.get(today) || 0;
    const updated = current + amount;
    dailyVolumeCache.set(today, updated);

    // Prune old keys to avoid memory leak
    if (dailyVolumeCache.size > 7) {
        const sortedKeys = [...dailyVolumeCache.keys()].sort();
        for (const key of sortedKeys.slice(0, -7)) {
            dailyVolumeCache.delete(key);
        }
    }

    return updated;
};

/**
 * Check if we should reset daily volume (call at startup)
 */
const initDailyVolumeTracking = () => {
    const today = getTodayKey();
    if (!dailyVolumeCache.has(today)) {
        dailyVolumeCache.set(today, 0);
    }
    Logger.info(`📅 每日交易量追踪已初始化，今日已用: $${getDailyVolume().toFixed(2)}`);
};

// Track if executor should continue running
let isRunning = true;

/**
 * Stop the trade executor gracefully
 */
export const stopTradeExecutor = () => {
    isRunning = false;
    Logger.info('交易执行器已请求关闭...');
};

const tradeExecutor = async (clobClient: ClobClient) => {
    initDailyVolumeTracking();
    Logger.success(`交易执行器就绪，正在监控 ${USER_ADDRESSES.length} 位交易员`);
    if (TRADE_AGGREGATION_ENABLED) {
        Logger.info(
            `交易聚合已启用: ${TRADE_AGGREGATION_WINDOW_SECONDS} 秒窗口，最低 $${TRADE_AGGREGATION_MIN_TOTAL_USD}`
        );
    }

    let lastCheck = Date.now();
    while (isRunning) {
        const trades = await readTempTrades();

        if (TRADE_AGGREGATION_ENABLED) {
            // Process with aggregation logic
            if (trades.length > 0) {
                Logger.clearLine();
                Logger.info(
                    `📥 检测到 ${trades.length} 笔新交易`
                );

                // Add trades to aggregation buffer
                for (const trade of trades) {
                    if (trade.side === 'BUY' && trade.usdcSize < TRADE_AGGREGATION_MIN_TOTAL_USD) {
                        Logger.info(
                            `正在将 $${trade.usdcSize.toFixed(2)} 的 ${trade.side} 交易加入聚合缓冲: ${trade.slug || trade.asset}`
                        );
                        addToAggregationBuffer(trade);
                    } else {
                        Logger.clearLine();
                        Logger.header(`⚡ 立即执行 (超过阈值)`);
                        await doTrading(clobClient, [trade]);
                    }
                }
                lastCheck = Date.now();
            }

            // Check for ready aggregated trades
            const readyAggregations = getReadyAggregatedTrades();
            if (readyAggregations.length > 0) {
                Logger.clearLine();
                Logger.header(
                    `⚡ ${readyAggregations.length} 笔聚合交易已就绪`
                );
                await doAggregatedTrading(clobClient, readyAggregations);
                lastCheck = Date.now();
            }

            // Update waiting message
            if (trades.length === 0 && readyAggregations.length === 0) {
                if (Date.now() - lastCheck > 300) {
                    const bufferedCount = tradeAggregationBuffer.size;
                    if (bufferedCount > 0) {
                        Logger.waiting(
                            USER_ADDRESSES.length,
                            `${bufferedCount} 个交易组待处理`
                        );
                    } else {
                        Logger.waiting(USER_ADDRESSES.length);
                    }
                    lastCheck = Date.now();
                }
            }
        } else {
            if (trades.length > 0) {
                Logger.clearLine();
                Logger.header(
                    `⚡ 检测到 ${trades.length} 笔新交易待跟单`
                );
                await doTrading(clobClient, trades);
                lastCheck = Date.now();
            } else {
                if (Date.now() - lastCheck > 300) {
                    Logger.waiting(USER_ADDRESSES.length);
                    lastCheck = Date.now();
                }
            }
        }

        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    Logger.info('交易执行器已停止');
};

export default tradeExecutor;
