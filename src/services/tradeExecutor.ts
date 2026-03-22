import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV, getCopyModeForTrader } from '../config/env';
import {
    getTradeMultiplier,
    getActualSide,
    CopyMode,
    copyModeLabelZh,
    copyModeLabelZhShort,
    copyModeEnvColumnHint,
} from '../config/copyStrategy';
import { getUserActivityModel } from '../models/userHistory';
import { resolveReverseAssetForCondition } from '../utils/conditionTokens';
import { fetchPositionsForUser } from '../utils/dataApiCache';
import getMyBalance from '../utils/getMyBalance';
import postOrder from '../utils/postOrder';
import Logger from '../utils/logger';
import { getProxyPortfolioMarkUsd } from '../utils/tokenMark';
import { resolveCopyOutcomeLabels } from '../utils/copyOutcomeLabels';
import { formatBeijingDateTime } from '../utils/time';
import { notifyCopyRiskStop } from '../utils/emailNotifier';
import { runPositionReconciliation } from './positionReconciliation';
import { isRetryableTransientError, transientBackoffMs, sleep } from '../utils/transientErrors';

const TRADE_AGGREGATION_MIN_TOTAL_USD = 1.0; // Polymarket minimum

let lastPortfolioCurPriceLogAt = 0;
/** 防止同一笔交易在短时间内被重复执行（API 抖动 / DB 重复记录） */
const RECENT_TRADE_DEDUP_TTL_MS = 10 * 60 * 1000;
const recentHandledTradeKeys = new Map<string, number>();

const makeTradeDedupKey = (trade: TradeWithUser): string =>
    `${trade.userAddress}:${trade.transactionHash}:${trade.asset}:${trade.side || 'BUY'}`;

const seenRecently = (key: string): boolean => {
    const ts = recentHandledTradeKeys.get(key);
    if (!ts) return false;
    return Date.now() - ts < RECENT_TRADE_DEDUP_TTL_MS;
};

const touchRecentKey = (key: string): void => {
    recentHandledTradeKeys.set(key, Date.now());
    // 轻量清理，防止 map 长期增长
    if (recentHandledTradeKeys.size > 2000) {
        const now = Date.now();
        for (const [k, at] of recentHandledTradeKeys) {
            if (now - at >= RECENT_TRADE_DEDUP_TTL_MS) {
                recentHandledTradeKeys.delete(k);
            }
        }
    }
};

type DoubleSideBuyLockEntry = {
    asset: string;
    at: number;
};

// In-process single-side lock: avoid opposite BUY slipping through when positions API lags.
const doubleSideBuyLocks = new Map<string, DoubleSideBuyLockEntry>();

const pruneDoubleSideBuyLocks = (): void => {
    const now = Date.now();
    for (const [conditionId, entry] of doubleSideBuyLocks) {
        if (now - entry.at >= ENV.COPY_DOUBLE_SIDE_GUARD_LOCK_TTL_MS) {
            doubleSideBuyLocks.delete(conditionId);
        }
    }
};

const getLockedAsset = (conditionId: string): string | undefined => {
    const lock = doubleSideBuyLocks.get(conditionId);
    if (!lock) return undefined;
    if (Date.now() - lock.at >= ENV.COPY_DOUBLE_SIDE_GUARD_LOCK_TTL_MS) {
        doubleSideBuyLocks.delete(conditionId);
        return undefined;
    }
    return lock.asset;
};

const lockConditionAsset = (conditionId: string, asset: string): void => {
    doubleSideBuyLocks.set(conditionId, { asset, at: Date.now() });
    if (doubleSideBuyLocks.size > 2000) {
        pruneDoubleSideBuyLocks();
    }
};

/** Optional: log proxy wallet mark (curPrice，与盘口背离时用 mid)；throttled by env. */
const maybeLogLivePortfolioCurPrice = async (clobClient: ClobClient): Promise<void> => {
    const intervalMs = ENV.LIVE_PORTFOLIO_CURPRICE_LOG_INTERVAL_MS;
    if (!intervalMs || intervalMs <= 0) return;
    const now = Date.now();
    if (now - lastPortfolioCurPriceLogAt < intervalMs) return;
    lastPortfolioCurPriceLogAt = now;
    try {
        const v = await getProxyPortfolioMarkUsd(clobClient);
        Logger.info(`💼 持仓市值估值(curPrice/盘口): ~$${v.toFixed(2)}`);
    } catch {
        // ignore
    }
};

const buildUserActivityModels = () =>
    ENV.USER_ADDRESSES.map((address) => ({
        address,
        model: getUserActivityModel(address),
    }));

interface TradeWithUser extends UserActivityInterface {
    userAddress: string;
}

type TraderRiskState = {
    consecutiveLosses: number;
    cumulativeLossUsd: number;
    stopped: boolean;
    reason?: string;
};

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

const traderRiskStates = new Map<string, TraderRiskState>();

const getTraderRiskState = (userAddress: string): TraderRiskState => {
    const existing = traderRiskStates.get(userAddress);
    if (existing) return existing;
    const fresh: TraderRiskState = {
        consecutiveLosses: 0,
        cumulativeLossUsd: 0,
        stopped: false,
    };
    traderRiskStates.set(userAddress, fresh);
    return fresh;
};

const isTraderStopped = (userAddress: string): boolean =>
    ENV.COPY_STOP_ON_LOSS_ENABLED && getTraderRiskState(userAddress).stopped;

const handleTraderRiskAfterSell = async (
    userAddress: string,
    realizedPnlUsd: number
): Promise<void> => {
    if (!ENV.COPY_STOP_ON_LOSS_ENABLED) return;
    const state = getTraderRiskState(userAddress);
    if (state.stopped) return;

    if (realizedPnlUsd < 0) {
        state.consecutiveLosses += 1;
        state.cumulativeLossUsd += Math.abs(realizedPnlUsd);
    } else {
        state.consecutiveLosses = 0;
    }

    const hitStreak = state.consecutiveLosses >= ENV.COPY_STOP_LOSS_STREAK;
    const hitAmount = state.cumulativeLossUsd >= ENV.COPY_STOP_LOSS_USD;
    if (!hitStreak && !hitAmount) return;

    state.stopped = true;
    state.reason = hitStreak
        ? `连续亏损达到 ${state.consecutiveLosses} 次（阈值 ${ENV.COPY_STOP_LOSS_STREAK}）`
        : `累计亏损达到 $${state.cumulativeLossUsd.toFixed(2)}（阈值 $${ENV.COPY_STOP_LOSS_USD.toFixed(2)}）`;

    const riskMode = getCopyModeForTrader(userAddress);
    Logger.warning(
        `🛑 已停止跟单交易员 ${userAddress.slice(0, 6)}...${userAddress.slice(-4)} [${copyModeLabelZhShort(riskMode)} / ${copyModeEnvColumnHint(riskMode)}]：${state.reason}`
    );
    await notifyCopyRiskStop({
        trader: userAddress,
        reason: state.reason,
        consecutiveLosses: state.consecutiveLosses,
        cumulativeLossUsd: state.cumulativeLossUsd,
        mode: 'LIVE',
        copyMode: riskMode === CopyMode.REVERSE ? 'REVERSE' : 'FOLLOW',
        copyModeDetailZh: `${copyModeLabelZh(riskMode)} · .env 列 ${copyModeEnvColumnHint(riskMode)}`,
    });
};

// Buffer for aggregating trades
const tradeAggregationBuffer: Map<string, AggregatedTrade> = new Map();
// Runtime position usd snapshot per condition+asset.
// Used to enforce MAX_POSITION_SIZE_USD even when positions API has refresh lag.
const runtimePositionUsdByKey = new Map<string, number>();

// Only execute trades that were detected after this executor started.
// This prevents older Mongo "bot: true && botExcutedTime: 0" records
// from being executed immediately after restart.
let tradeExecutorStartTimestamp = 0;

const readTempTrades = async (): Promise<TradeWithUser[]> => {
    const allTrades: TradeWithUser[] = [];

    for (const { address, model } of buildUserActivityModels()) {
        // Only get trades that have been claimed by the monitor (bot: true AND botExcutedTime: 0)
        // The monitor sets bot: true when it first sees a new trade, preventing duplicate detection
        const trades = await model
            .find({
                $and: [
                    { type: 'TRADE' },
                    { bot: true },
                    { botExcutedTime: 0 },
                    // When tradeExecutorStartTimestamp is set (non-zero),
                    // this guarantees we only execute trades created after startup.
                    ...(tradeExecutorStartTimestamp
                        ? [{ timestamp: { $gte: tradeExecutorStartTimestamp } }]
                        : []),
                ],
            })
            .exec();

        const tradesWithUser = trades.map((trade) => ({
            ...(trade.toObject() as UserActivityInterface),
            userAddress: address,
        }));

        allTrades.push(
            ...tradesWithUser.filter((trade) => {
                if (!isTraderStopped(trade.userAddress)) return true;
                // Stop backlog growth for blocked traders.
                model.updateOne(
                    { _id: trade._id },
                    { $set: { bot: true, botExcutedTime: 1 } }
                ).exec();
                return false;
            })
        );
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
    const windowMs = ENV.TRADE_AGGREGATION_WINDOW_SECONDS * 1000;

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
                    // Important: set botExcutedTime so they won't be re-read next poll.
                    UserActivity.updateOne(
                        { _id: trade._id },
                        { $set: { bot: true, botExcutedTime: 1 } }
                    ).exec();
                }
            }
            // Remove from buffer either way
            tradeAggregationBuffer.delete(key);
        }
    }

    return ready;
};

const positionUsdKey = (conditionId: string, asset: string): string => `${conditionId}:${asset}`;

const doTrading = async (clobClient: ClobClient, trades: TradeWithUser[]) => {
    for (const trade of trades) {
        const UserActivity = getUserActivityModel(trade.userAddress);
        const dedupKey = makeTradeDedupKey(trade);
        if (isTraderStopped(trade.userAddress)) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { $set: { bot: true, botExcutedTime: 1 } }
            );
            Logger.warning(
                `已停止该交易员跟单，跳过: ${trade.userAddress.slice(0, 6)}...${trade.userAddress.slice(-4)}`
            );
            Logger.separator();
            continue;
        }

        if (seenRecently(dedupKey)) {
            Logger.warning(`检测到重复待执行交易（短期去重）：${trade.transactionHash.slice(0, 12)}...，跳过`);
            await UserActivity.updateOne(
                { _id: trade._id },
                { $set: { bot: true, botExcutedTime: 1 } }
            );
            Logger.separator();
            continue;
        }

        const copyMode = getCopyModeForTrader(trade.userAddress);

        const my_positions = (await fetchPositionsForUser(ENV.PROXY_WALLET)) as UserPositionInterface[];
        const user_positions = (await fetchPositionsForUser(trade.userAddress)) as UserPositionInterface[];

        // REVERSE mode safety:
        // If oppositeAsset is missing/invalid, resolve it from trader's positions we already fetched.
        // This makes `npm run dev` support REVERSE reliably even when monitor hasn't persisted oppositeAsset yet.
        if (copyMode === CopyMode.REVERSE) {
            const validated = await resolveReverseAssetForCondition(
                trade.conditionId,
                trade.asset,
                trade.oppositeAsset
            );
            if (validated.oppositeAsset && validated.oppositeAsset !== trade.oppositeAsset) {
                trade.oppositeAsset = validated.oppositeAsset;
                await UserActivity.updateOne(
                    { _id: trade._id },
                    { $set: { oppositeAsset: validated.oppositeAsset } }
                );
                Logger.info(
                    `🔎 反买校验: 根据 conditionId 修正 oppositeAsset -> ${validated.oppositeAsset.slice(0, 12)}...`
                );
            }

            const needsResolve =
                !trade.oppositeAsset || trade.oppositeAsset === trade.asset;

            if (needsResolve) {
                const posForTradeAsset = user_positions.find(
                    (p: UserPositionInterface) =>
                        p.conditionId === trade.conditionId && p.asset === trade.asset
                );

                const resolved = posForTradeAsset?.oppositeAsset;
                if (resolved && resolved !== trade.asset) {
                    // Update in-memory trade and persist for future executions
                    trade.oppositeAsset = resolved;
                    await UserActivity.updateOne(
                        { _id: trade._id },
                        { $set: { oppositeAsset: resolved } }
                    );
                    Logger.info(
                        `🔄 反买模式: 补齐 oppositeAsset（从 trader positions）-> ${resolved.slice(0, 12)}...`
                    );
                }
            }
        }

        if (copyMode === CopyMode.REVERSE) {
            if (!trade.oppositeAsset || trade.oppositeAsset === trade.asset) {
                Logger.warning(
                    '⚠️ 反买模式: 缺少有效 oppositeAsset，本笔已跳过（避免按错误代币下单）'
                );
                await UserActivity.updateOne(
                    { _id: trade._id },
                    { $set: { bot: true, botExcutedTime: 1 } }
                );
                Logger.separator();
                continue;
            }
        }

        await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 1 } });
        touchRecentKey(dedupKey);

        const actualSide = getActualSide(trade.side || 'BUY', copyMode);
        const buyTargetAsset =
            actualSide === 'BUY'
                ? (
                      copyMode === CopyMode.REVERSE
                          ? (trade.oppositeAsset || trade.asset)
                          : trade.asset
                  )
                : undefined;
        const tradedAsset =
            copyMode === CopyMode.REVERSE
                ? (trade.oppositeAsset || trade.asset)
                : trade.asset;
        const posUsdKey = positionUsdKey(trade.conditionId, tradedAsset);
        const outcomeLabels = resolveCopyOutcomeLabels(
            copyMode,
            trade,
            user_positions
        );

        if (copyMode === CopyMode.REVERSE) {
            const ourAsset = trade.oppositeAsset || trade.asset;
            Logger.info(`🔄 反买模式: 交易员 ${trade.side} ${trade.asset.slice(0, 12)}... → 我 ${actualSide} ${ourAsset.slice(0, 12)}...`);
        }

        Logger.trade(trade.userAddress, actualSide, {
            asset: trade.asset,
            side: trade.side,
            amount: trade.usdcSize,
            price: trade.price,
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            transactionHash: trade.transactionHash,
            title: trade.title,
            traderOutcome: outcomeLabels.traderOutcome,
            myOutcome: outcomeLabels.myOutcome,
            outcomeModeHint: outcomeLabels.modeHint,
            copyModeLabel: `${copyModeLabelZh(copyMode)} · ${copyModeEnvColumnHint(copyMode)}`,
        });

        // In REVERSE mode, find position on opposite side (we hold opposite tokens to trader)
        // In FOLLOW mode, find position on same side as trader
        let my_position = my_positions.find((position: UserPositionInterface) => {
            if (copyMode === CopyMode.REVERSE) {
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
        const my_balance = await getMyBalance(ENV.PROXY_WALLET);

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
        if (actualSide === 'BUY') {
            const targetAsset = buyTargetAsset as string;
            const lockedAsset = getLockedAsset(trade.conditionId);
            if (
                ENV.COPY_DOUBLE_SIDE_GUARD_MODE !== 'OFF' &&
                lockedAsset &&
                lockedAsset !== targetAsset
            ) {
                Logger.warning(
                    `⏭ 跳过两头买(内存锁): 条件 ${trade.conditionId.slice(0, 12)}... 已锁定 ${lockedAsset.slice(0, 12)}...，当前尝试 ${targetAsset.slice(0, 12)}...`
                );
                await UserActivity.updateOne(
                    { _id: trade._id },
                    { $set: { bot: true, botExcutedTime: 1 } }
                );
                Logger.separator();
                continue;
            }
            const oppositeHeld = my_positions.find(
                (p: UserPositionInterface) =>
                    p.conditionId === trade.conditionId &&
                    p.asset !== targetAsset &&
                    (p.size || 0) > 0.0001
            );
            let shouldBlock = false;
            if (ENV.COPY_DOUBLE_SIDE_GUARD_MODE !== 'OFF' && oppositeHeld) {
                if (ENV.COPY_DOUBLE_SIDE_GUARD_MODE === 'TRADER_ONLY') {
                    const oppositeBoughtBySameTrader = await UserActivity.exists({
                        conditionId: trade.conditionId,
                        type: 'TRADE',
                        side: 'BUY',
                        asset: oppositeHeld.asset,
                        bot: true,
                        myBoughtSize: { $exists: true, $gt: 0 },
                    });
                    shouldBlock = !!oppositeBoughtBySameTrader;
                } else {
                    shouldBlock = true;
                }
            }
            if (shouldBlock && oppositeHeld) {
                Logger.warning(
                    `⏭ 跳过两头买(${ENV.COPY_DOUBLE_SIDE_GUARD_MODE}): 条件 ${trade.conditionId.slice(0, 12)}... 已持有另一侧仓位 (${oppositeHeld.outcome || oppositeHeld.asset.slice(0, 12)}...)`
                );
                await UserActivity.updateOne(
                    { _id: trade._id },
                    { $set: { bot: true, botExcutedTime: 1 } }
                );
                Logger.separator();
                continue;
            }
        }

        const executedUsdc = await postOrder(
            clobClient,
            actualSide === 'BUY' ? 'buy' : 'sell',
            my_position,
            user_position,
            trade,
            my_balance,
            user_balance,
            trade.userAddress,
            dailyVol,
            async (summary) => {
                await handleTraderRiskAfterSell(trade.userAddress, summary.realizedPnlUsd);
            },
            Math.max(
                my_position ? my_position.size * my_position.avgPrice : 0,
                runtimePositionUsdByKey.get(posUsdKey) || 0
            )
        );

        // Track daily volume after successful trade
        if (executedUsdc > 0) {
            addDailyVolume(executedUsdc);
            Logger.info(`📈 今日累计交易量: $${getDailyVolume().toFixed(2)}`);
            await maybeLogLivePortfolioCurPrice(clobClient);
            if (actualSide === 'BUY' && buyTargetAsset) {
                lockConditionAsset(trade.conditionId, buyTargetAsset);
            }
            const baseUsd = Math.max(
                my_position ? my_position.size * my_position.avgPrice : 0,
                runtimePositionUsdByKey.get(posUsdKey) || 0
            );
            runtimePositionUsdByKey.set(
                posUsdKey,
                actualSide === 'BUY'
                    ? baseUsd + executedUsdc
                    : Math.max(0, baseUsd - executedUsdc)
            );
        }

        Logger.separator();
    }
};

/**
 * Execute aggregated trades
 */
const doAggregatedTrading = async (clobClient: ClobClient, aggregatedTrades: AggregatedTrade[]) => {
    for (const agg of aggregatedTrades) {
        if (isTraderStopped(agg.userAddress)) {
            for (const tr of agg.trades) {
                const UA = getUserActivityModel(tr.userAddress);
                await UA.updateOne(
                    { _id: tr._id },
                    { $set: { bot: true, botExcutedTime: 1 } }
                );
            }
            Logger.warning(
                `已停止该交易员跟单，跳过聚合组: ${agg.userAddress.slice(0, 6)}...${agg.userAddress.slice(-4)}`
            );
            continue;
        }
        Logger.header(`📊 聚合交易 (合并 ${agg.trades.length} 笔)`);
        Logger.info(`市场: ${agg.slug || agg.asset}`);
        Logger.info(`方向: ${agg.side}`);
        Logger.info(`总金额: $${agg.totalUsdcSize.toFixed(2)}`);
        Logger.info(`平均价格: $${agg.averagePrice.toFixed(4)}`);

        const my_positions = (await fetchPositionsForUser(ENV.PROXY_WALLET)) as UserPositionInterface[];
        const user_positions = (await fetchPositionsForUser(agg.userAddress)) as UserPositionInterface[];
        const copyMode = getCopyModeForTrader(agg.userAddress);
        Logger.info(
            `跟单配置: ${copyModeLabelZh(copyMode)} · .env 列 ${copyModeEnvColumnHint(copyMode)} · 交易员 ${agg.userAddress.slice(0, 6)}...${agg.userAddress.slice(-4)}`
        );

        // REVERSE mode safety for aggregated trades:
        // Ensure oppositeAsset is persisted/resolved before selecting our matching position.
        if (copyMode === CopyMode.REVERSE) {
            const templateTrade = agg.trades[0];
            const validated = await resolveReverseAssetForCondition(
                agg.conditionId,
                templateTrade.asset,
                templateTrade.oppositeAsset
            );
            if (validated.oppositeAsset && validated.oppositeAsset !== templateTrade.oppositeAsset) {
                for (const trade of agg.trades) {
                    trade.oppositeAsset = validated.oppositeAsset;
                    const UserActivity = getUserActivityModel(trade.userAddress);
                    await UserActivity.updateOne(
                        { _id: trade._id },
                        { $set: { oppositeAsset: validated.oppositeAsset } }
                    );
                }
                Logger.info(
                    `🔎 反买校验(聚合): 根据 conditionId 修正 oppositeAsset -> ${validated.oppositeAsset.slice(0, 12)}...`
                );
            }

            const needsResolve = !templateTrade.oppositeAsset || templateTrade.oppositeAsset === templateTrade.asset;

            if (needsResolve) {
                const posForTradeAsset = user_positions.find(
                    (p: UserPositionInterface) =>
                        p.conditionId === agg.conditionId && p.asset === templateTrade.asset
                );
                const resolved = posForTradeAsset?.oppositeAsset;

                if (resolved && resolved !== templateTrade.asset) {
                    for (const trade of agg.trades) {
                        const shouldUpdate = !trade.oppositeAsset || trade.oppositeAsset === trade.asset;
                        if (shouldUpdate) {
                            trade.oppositeAsset = resolved;
                            const UserActivity = getUserActivityModel(trade.userAddress);
                            await UserActivity.updateOne(
                                { _id: trade._id },
                                { $set: { oppositeAsset: resolved } }
                            );
                        }
                    }
                    Logger.info(
                        `🔄 反买模式(聚合): 补齐 oppositeAsset（从 trader positions）-> ${resolved.slice(0, 12)}...`
                    );
                }
            }
        }

        if (copyMode === CopyMode.REVERSE) {
            const t0 = agg.trades[0];
            if (!t0.oppositeAsset || t0.oppositeAsset === t0.asset) {
                Logger.warning(
                    '⚠️ 反买模式(聚合): 缺少有效 oppositeAsset，本组已跳过（避免按错误代币下单）'
                );
                for (const tr of agg.trades) {
                    const UA = getUserActivityModel(tr.userAddress);
                    await UA.updateOne(
                        { _id: tr._id },
                        { $set: { bot: true, botExcutedTime: 1 } }
                    );
                }
                Logger.separator();
                continue;
            }
        }

        for (const trade of agg.trades) {
            const UserActivity = getUserActivityModel(trade.userAddress);
            await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 1 } });
        }

        const templateTrade = agg.trades[0];
        const aggOutcomeLabels = resolveCopyOutcomeLabels(
            copyMode,
            templateTrade,
            user_positions
        );
        Logger.info(`📌 交易员 Outcome: ${aggOutcomeLabels.traderOutcome}`);
        Logger.info(
            `📌 我跟单 Outcome: ${aggOutcomeLabels.myOutcome}（${aggOutcomeLabels.modeHint}）`
        );

        // In REVERSE mode, find position on opposite side (we hold opposite tokens to trader)
        // In FOLLOW mode, find position on same side as trader
        let my_position = my_positions.find((position: UserPositionInterface) => {
            if (copyMode === CopyMode.REVERSE) {
                // REVERSE: match oppositeAsset to our position asset
                return (
                    position.conditionId === agg.conditionId &&
                    position.asset === agg.trades[0].oppositeAsset
                );
            }
            // FOLLOW: match same asset as trader
            return position.conditionId === agg.conditionId && position.asset === agg.asset;
        });
        const user_position = user_positions.find(
            (position: UserPositionInterface) => position.conditionId === agg.conditionId
        );

        // Get USDC balance
        const my_balance = await getMyBalance(ENV.PROXY_WALLET);

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
        const actualSide = getActualSide(agg.side as string, copyMode);
        const buyTargetAsset =
            actualSide === 'BUY'
                ? (
                      copyMode === CopyMode.REVERSE
                          ? (agg.trades[0].oppositeAsset || agg.asset)
                          : agg.asset
                  )
                : undefined;
        const tradedAsset =
            copyMode === CopyMode.REVERSE
                ? (agg.trades[0].oppositeAsset || agg.asset)
                : agg.asset;
        const posUsdKey = positionUsdKey(agg.conditionId, tradedAsset);
        const syntheticTrade: UserActivityInterface = {
            ...agg.trades[0], // Use first trade as template
            usdcSize: agg.totalUsdcSize,
            price: agg.averagePrice,
            side: agg.side as 'BUY' | 'SELL', // Market-side direction for history queries
        };

        if (copyMode === CopyMode.REVERSE) {
            const ourAsset = (agg.trades[0].oppositeAsset || agg.asset).slice(0, 12);
            Logger.info(`🔄 反买模式: 交易员 ${agg.side} ${agg.asset.slice(0, 12)}... → 我 ${actualSide} ${ourAsset}...`);
        }

        // Execute the aggregated trade
        if (actualSide === 'BUY') {
            const targetAsset = buyTargetAsset as string;
            const lockedAsset = getLockedAsset(agg.conditionId);
            if (
                ENV.COPY_DOUBLE_SIDE_GUARD_MODE !== 'OFF' &&
                lockedAsset &&
                lockedAsset !== targetAsset
            ) {
                Logger.warning(
                    `⏭ 跳过两头买(聚合内存锁): 条件 ${agg.conditionId.slice(0, 12)}... 已锁定 ${lockedAsset.slice(0, 12)}...，当前尝试 ${targetAsset.slice(0, 12)}...`
                );
                for (const tr of agg.trades) {
                    const UA = getUserActivityModel(tr.userAddress);
                    await UA.updateOne(
                        { _id: tr._id },
                        { $set: { bot: true, botExcutedTime: 1 } }
                    );
                }
                Logger.separator();
                continue;
            }
            const oppositeHeld = my_positions.find(
                (p: UserPositionInterface) =>
                    p.conditionId === agg.conditionId &&
                    p.asset !== targetAsset &&
                    (p.size || 0) > 0.0001
            );
            let shouldBlock = false;
            if (ENV.COPY_DOUBLE_SIDE_GUARD_MODE !== 'OFF' && oppositeHeld) {
                if (ENV.COPY_DOUBLE_SIDE_GUARD_MODE === 'TRADER_ONLY') {
                    const UA0 = getUserActivityModel(agg.userAddress);
                    const oppositeBoughtBySameTrader = await UA0.exists({
                        conditionId: agg.conditionId,
                        type: 'TRADE',
                        side: 'BUY',
                        asset: oppositeHeld.asset,
                        bot: true,
                        myBoughtSize: { $exists: true, $gt: 0 },
                    });
                    shouldBlock = !!oppositeBoughtBySameTrader;
                } else {
                    shouldBlock = true;
                }
            }
            if (shouldBlock && oppositeHeld) {
                Logger.warning(
                    `⏭ 跳过两头买(聚合, ${ENV.COPY_DOUBLE_SIDE_GUARD_MODE}): 条件 ${agg.conditionId.slice(0, 12)}... 已持有另一侧仓位 (${oppositeHeld.outcome || oppositeHeld.asset.slice(0, 12)}...)`
                );
                for (const tr of agg.trades) {
                    const UA = getUserActivityModel(tr.userAddress);
                    await UA.updateOne(
                        { _id: tr._id },
                        { $set: { bot: true, botExcutedTime: 1 } }
                    );
                }
                Logger.separator();
                continue;
            }
        }

        const executedUsdc = await postOrder(
            clobClient,
            actualSide === 'BUY' ? 'buy' : 'sell',
            my_position,
            user_position,
            syntheticTrade,
            my_balance,
            user_balance,
            agg.userAddress,
            dailyVol,
            async (summary) => {
                await handleTraderRiskAfterSell(agg.userAddress, summary.realizedPnlUsd);
            },
            Math.max(
                my_position ? my_position.size * my_position.avgPrice : 0,
                runtimePositionUsdByKey.get(posUsdKey) || 0
            )
        );

        // Track daily volume after successful trade
        if (executedUsdc > 0) {
            addDailyVolume(executedUsdc);
            Logger.info(`📈 今日累计交易量: $${getDailyVolume().toFixed(2)}`);
            await maybeLogLivePortfolioCurPrice(clobClient);
            if (actualSide === 'BUY' && buyTargetAsset) {
                lockConditionAsset(agg.conditionId, buyTargetAsset);
            }
            const baseUsd = Math.max(
                my_position ? my_position.size * my_position.avgPrice : 0,
                runtimePositionUsdByKey.get(posUsdKey) || 0
            );
            runtimePositionUsdByKey.set(
                posUsdKey,
                actualSide === 'BUY'
                    ? baseUsd + executedUsdc
                    : Math.max(0, baseUsd - executedUsdc)
            );
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
    tradeExecutorStartTimestamp = Math.floor(Date.now() / 1000);
    Logger.success(`交易执行器就绪，正在监控 ${ENV.USER_ADDRESSES.length} 位交易员`);
    Logger.info(
        `只执行启动后检测到的待执行单 (启动时间: ${formatBeijingDateTime(new Date(tradeExecutorStartTimestamp * 1000))})`
    );
    if (ENV.TRADE_AGGREGATION_ENABLED) {
        Logger.info(
            `交易聚合已启用: ${ENV.TRADE_AGGREGATION_WINDOW_SECONDS} 秒窗口，最低 $${TRADE_AGGREGATION_MIN_TOTAL_USD}`
        );
    }

    if (ENV.POSITION_RECONCILE_INTERVAL_MS > 0) {
        Logger.info(
            `🧹 仓位对账已启用: 每 ${ENV.POSITION_RECONCILE_INTERVAL_MS}ms（与 npm run dryrun 共用 POSITION_RECONCILE_*；详见 .env.example）`
        );
    }

    let lastCheck = Date.now();
    let lastPositionReconcileAt = 0;
    let transientStreak = 0;
    while (isRunning) {
        try {
        const trades = await readTempTrades();

        if (ENV.TRADE_AGGREGATION_ENABLED) {
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
                            ENV.USER_ADDRESSES.length,
                            `${bufferedCount} 个交易组待处理`
                        );
                    } else {
                        Logger.waiting(ENV.USER_ADDRESSES.length);
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
                    Logger.waiting(ENV.USER_ADDRESSES.length);
                    lastCheck = Date.now();
                }
            }
        }

        if (!isRunning) break;

        // Periodic reconciliation: free USDC when trader exited mirror leg or market resolved
        const reconcileInterval = ENV.POSITION_RECONCILE_INTERVAL_MS;
        if (reconcileInterval > 0) {
            const now = Date.now();
            if (now - lastPositionReconcileAt >= reconcileInterval) {
                lastPositionReconcileAt = now;
                try {
                    await runPositionReconciliation(clobClient, { onSoldUsd: addDailyVolume });
                } catch (reconcileErr) {
                    Logger.error(`仓位对账失败: ${reconcileErr}`);
                }
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
        transientStreak = 0;
        } catch (err) {
            if (!isRunning) break;
            if (!isRetryableTransientError(err)) {
                Logger.error(`交易执行器不可恢复错误: ${err}`);
                throw err;
            }
            transientStreak += 1;
            const delayMs = transientBackoffMs(transientStreak);
            Logger.warning(
                `交易执行器临时故障（Mongo/网络等），约 ${(delayMs / 1000).toFixed(1)}s 后重试（连续 ${transientStreak} 次）: ${err}`
            );
            await sleep(delayMs);
        }
    }

    Logger.info('交易执行器已停止');
};

export default tradeExecutor;
