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
import postOrder, { marketSellTokensFOK } from '../utils/postOrder';
import { fetchOrderBookCached } from '../utils/postOrder';
import Logger from '../utils/logger';
import { getProxyPortfolioMarkUsd } from '../utils/tokenMark';
import { resolveCopyOutcomeLabels } from '../utils/copyOutcomeLabels';
import { formatBeijingDateTime } from '../utils/time';
import { notifyCopyRiskStop } from '../utils/emailNotifier';
import { runPositionReconciliation } from './positionReconciliation';
import { RECONCILE_MIN_SELL_TOKENS, RESOLVED_HIGH, RESOLVED_LOW } from './positionReconciliationCore';
import { isRetryableTransientError, transientBackoffMs, sleep } from '../utils/transientErrors';
import {
    estimateSellProceedsFromBids,
    estimateSellPnlPctFromBids,
    formatTpSlThresholdsZh,
    getPercentPnlFromPosition,
    makePositionKey,
    resolveRefAvgPriceForExit,
    shouldTriggerProfitExit,
} from '../utils/profitExit';
import { recordCopyTrackingFill } from './copyTrackingService';

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

type ProfitExitWatch = {
    positionKey: string;
    conditionId: string;
    asset: string;
    marketTitle: string;
    txHashes: Set<string>;
    trackedCostBasisUsd: number;
    lastExitAttemptAt: number;
    registeredAt: number;
    lastMissingLogAt: number;
};

// Keyed by "conditionId:asset" (lowercased) — once the position is exited, we remove all linked txHash watches.
const profitExitWatchesByPositionKey: Map<string, ProfitExitWatch> = new Map();
let lastProfitExitCheckAt = 0;

const registerProfitExitWatch = (
    txHash: string | undefined,
    conditionId: string,
    asset: string,
    marketTitle: string,
    executedUsdc: number
): void => {
    if (!ENV.AUTO_PROFIT_EXIT_ENABLED) return;
    if (!txHash) return;
    const positionKey = makePositionKey(conditionId, asset);

    const existing = profitExitWatchesByPositionKey.get(positionKey);
    if (existing) {
        const isNewTx = !existing.txHashes.has(txHash);
        existing.txHashes.add(txHash);
        if (isNewTx && Number.isFinite(executedUsdc) && executedUsdc > 0) {
            existing.trackedCostBasisUsd += executedUsdc;
        }
        if (!existing.marketTitle && marketTitle) existing.marketTitle = marketTitle;
        return;
    }

    profitExitWatchesByPositionKey.set(positionKey, {
        positionKey,
        conditionId,
        asset,
        marketTitle,
        txHashes: new Set([txHash]),
        trackedCostBasisUsd: Number.isFinite(executedUsdc) && executedUsdc > 0 ? executedUsdc : 0,
        lastExitAttemptAt: 0,
        registeredAt: Date.now(),
        lastMissingLogAt: 0,
    });
};

const clearBuyTrackingForAsset = async (
    conditionId: string,
    asset: string,
    marketTitle?: string
): Promise<void> => {
    // 清理 tracked BUY 追踪，使后续 sell 策略不会再依赖该仓位的 myBoughtSize 计算。
    Logger.info(
        `🧹 [AUTO EXIT] clearing tracked BUY: market=${
            marketTitle || ''
        } | condition=${conditionId.slice(0, 14)}... asset=${asset.slice(0, 12)}... traders=${
            ENV.USER_ADDRESSES.length
        }`
    );
    for (const traderAddr of ENV.USER_ADDRESSES) {
        const Model = getUserActivityModel(traderAddr);
        await Model.updateMany(
            {
                conditionId,
                $or: [{ asset }, { oppositeAsset: asset }],
                side: 'BUY',
                bot: true,
                myBoughtSize: { $exists: true, $gt: 0 },
            },
            { $set: { myBoughtSize: 0 } }
        );
    }
};

const hasAnyTrackedBuy = async (conditionId: string, asset: string): Promise<boolean> => {
    // Throttle should be handled by caller; this function is called only when we really need it.
    for (const traderAddr of ENV.USER_ADDRESSES) {
        const Model = getUserActivityModel(traderAddr);
        const doc = await Model.findOne(
            {
                conditionId,
                $or: [{ asset }, { oppositeAsset: asset }],
                side: 'BUY',
                bot: true,
                myBoughtSize: { $exists: true, $gt: 0 },
            },
            { _id: 1 }
        )
            .lean()
            .exec();
        if (doc) return true;
    }
    return false;
};

const countTrackedBuys = async (conditionId: string, asset: string): Promise<number> => {
    let total = 0;
    for (const traderAddr of ENV.USER_ADDRESSES) {
        const Model = getUserActivityModel(traderAddr);
        const cnt = await Model.countDocuments({
            conditionId,
            $or: [{ asset }, { oppositeAsset: asset }],
            side: 'BUY',
            bot: true,
            myBoughtSize: { $exists: true, $gt: 0 },
        })
            .exec();
        total += Number(cnt || 0);
    }
    return total;
};

const maybeAutoProfitExit = async (clobClient: ClobClient): Promise<void> => {
    if (!ENV.AUTO_PROFIT_EXIT_ENABLED) return;
    const interval = ENV.AUTO_PROFIT_EXIT_CHECK_INTERVAL_MS;
    if (!interval || interval <= 0) return;
    if (profitExitWatchesByPositionKey.size === 0) return;

    const now = Date.now();
    if (now - lastProfitExitCheckAt < interval) return;
    lastProfitExitCheckAt = now;

    const proxyPositions = (await fetchPositionsForUser(ENV.PROXY_WALLET)) as UserPositionInterface[];
    const byKey = new Map<string, UserPositionInterface>();
    for (const p of proxyPositions || []) {
        if (!p?.conditionId || !p?.asset) continue;
        byKey.set(makePositionKey(p.conditionId, p.asset), p);
    }

        for (const [positionKey, watch] of profitExitWatchesByPositionKey.entries()) {
        const pos = byKey.get(positionKey);
        const size = pos?.size || 0;

        // If positions API hasn't reflected the new buy yet, keep the watch
        // and continue checking every AUTO_PROFIT_EXIT_CHECK_INTERVAL_MS.
        if (!pos || size <= 0) {
            let didLogMissing = false;
            if (now - watch.lastMissingLogAt > 5000) {
                watch.lastMissingLogAt = now;
                didLogMissing = true;
                        Logger.info(
                            `⏳ [AUTO EXIT] waiting positions reflect new buy: market=${
                                watch.marketTitle || ''
                            } | condition=${watch.conditionId.slice(0, 14)}... asset=${watch.asset.slice(
                                0,
                                12
                            )}... watchAge=${((now - watch.registeredAt) / 1000).toFixed(1)}s`
                        );
            }

            // Only when we emitted the missing-position log to avoid DB spam.
            if (didLogMissing) {
                // Grace period: avoid a race where myBoughtSize / tracked BUY is not written yet,
                // but positions API is temporarily behind. During this window we should keep watching,
                // otherwise we can miss the TP/SL trigger and never try to sell.
                const trackingGraceMs = Math.max(5000, ENV.AUTO_PROFIT_EXIT_CHECK_INTERVAL_MS * 5);
                if (now - watch.registeredAt >= trackingGraceMs) {
                    try {
                        const trackedCount = await countTrackedBuys(watch.conditionId, watch.asset);
                        const trackedStillExists = await hasAnyTrackedBuy(watch.conditionId, watch.asset);
                        if (!trackedStillExists) {
                            Logger.warning(
                                `🛑 [AUTO EXIT] positions 已不在且 tracked BUY 已清零：停止跟踪 market=${
                                    watch.marketTitle || ''
                                } | condition=${watch.conditionId.slice(0, 10)}... asset=${watch.asset.slice(
                                    0,
                                    12
                                )}... | trackedCount=${trackedCount}`
                            );
                            profitExitWatchesByPositionKey.delete(positionKey);
                        }
                    } catch {
                        // If DB check fails, keep the watch; worst case is extra polling.
                    }
                }
            }
            continue;
        }

        if (size < ENV.AUTO_PROFIT_EXIT_CLEAR_WHEN_REMAINING_LT_TOKENS) {
            Logger.warning(
                `⏭️ [AUTO EXIT] 跳过卖出：market=${
                    watch.marketTitle || ''
                } | remaining size=${size.toFixed(4)} < clearThreshold=${ENV.AUTO_PROFIT_EXIT_CLEAR_WHEN_REMAINING_LT_TOKENS.toFixed(
                    4
                )} tokens（停止跟踪该仓位）`
            );
            await clearBuyTrackingForAsset(watch.conditionId, watch.asset, watch.marketTitle);
            profitExitWatchesByPositionKey.delete(positionKey);
            continue;
        }

        const percentPnlFromPosition = getPercentPnlFromPosition(pos);
        if (percentPnlFromPosition == null) continue;

        // 触发口径：严格以 polymarket positions API 的 ROI（pos.percentPnl / initialValue/currentValue）
        // 为准，不再使用 orderbook bid 做保守 min()，避免出现“看起来已到 TP/SL 但未触发”的偏差。
        const percentPnlUsed = percentPnlFromPosition;

        const { triggered, reason } = shouldTriggerProfitExit({
            percentPnl: percentPnlUsed,
            takeProfitPct: ENV.AUTO_PROFIT_EXIT_TAKE_PROFIT_PCT,
            stopLossPct: ENV.AUTO_PROFIT_EXIT_STOP_LOSS_PCT,
        });
        if (!triggered) continue;

        // Throttle retries for the same position.
        if (now - watch.lastExitAttemptAt < ENV.AUTO_PROFIT_EXIT_RETRY_COOLDOWN_MS) {
            continue;
        }
        watch.lastExitAttemptAt = now;

        const takeProfitPct = ENV.AUTO_PROFIT_EXIT_TAKE_PROFIT_PCT;
        const stopLossPct = ENV.AUTO_PROFIT_EXIT_STOP_LOSS_PCT;
        const isTakeProfit = takeProfitPct > 0 && percentPnlUsed >= takeProfitPct;
        const txHashArr = Array.from(watch.txHashes);
        const txLog = `${txHashArr
            .slice(0, 3)
            .map((h) => `${h.slice(0, 6)}...${h.slice(-4)}`)
            .join(',')}${txHashArr.length > 3 ? ` +${txHashArr.length - 3} more` : ''}`;

        const refAvgPrice = resolveRefAvgPriceForExit({
            posAvgPrice: pos.avgPrice,
            trackedCostBasisUsd: watch.trackedCostBasisUsd,
            size,
        });

        if (isTakeProfit && refAvgPrice <= 0) {
            Logger.warning(
                `⏭️ [AUTO EXIT] 跳过止盈：无法估算成本均价（API avg 无效且本地无有效投入记录）| market=${
                    watch.marketTitle || ''
                } | condition=${watch.conditionId.slice(0, 10)}... asset=${watch.asset.slice(0, 12)}...`
            );
            continue;
        }

        if (isTakeProfit && refAvgPrice > 0) {
            try {
                const ob = await fetchOrderBookCached(clobClient, watch.asset);
                const bids: any[] = Array.isArray((ob as any)?.bids) ? (ob as any).bids : [];

                if (watch.trackedCostBasisUsd > 0) {
                    const estimate = estimateSellProceedsFromBids({ size, bids });
                    const requiredProceeds = watch.trackedCostBasisUsd * (1 + takeProfitPct / 100);
                    if (!estimate || estimate.proceeds < requiredProceeds) {
                        Logger.warning(
                            `⏭️ [AUTO EXIT] 跳过止盈执行：预估可成交额≈$${estimate ? estimate.proceeds.toFixed(2) : 'n/a'} < 目标止盈额≈$${requiredProceeds.toFixed(
                                2
                            )}（投入≈$${watch.trackedCostBasisUsd.toFixed(2)}，TP=${takeProfitPct.toFixed(2)}%） | market=${watch.marketTitle || ''} | condition=${watch.conditionId.slice(
                                0,
                                10
                            )}... asset=${watch.asset.slice(0, 12)}...`
                        );
                        continue;
                    }
                }

                const execPnlPct = estimateSellPnlPctFromBids({
                    avgPrice: refAvgPrice,
                    size,
                    bids,
                });
                const minExecPnlPct = ENV.AUTO_PROFIT_EXIT_TAKE_PROFIT_MIN_EXEC_PNL_PCT;
                if (execPnlPct == null || execPnlPct < minExecPnlPct) {
                    Logger.warning(
                        `⏭️ [AUTO EXIT] 跳过止盈执行：预估可成交Pnl=${execPnlPct != null ? execPnlPct.toFixed(2) + '%' : 'n/a'} < 最低执行阈值=${minExecPnlPct.toFixed(
                            2
                        )}% | market=${watch.marketTitle || ''} | condition=${watch.conditionId.slice(0, 10)}... asset=${watch.asset.slice(
                            0,
                            12
                        )}...`
                    );
                    continue;
                }
            } catch (e) {
                Logger.warning(
                    `⏭️ [AUTO EXIT] 跳过止盈执行：订单簿预估失败（保守处理，等待下轮）| market=${watch.marketTitle || ''} | err=${String(
                        e
                    )}`
                );
                continue;
            }
        }

        Logger.warning(
            `⚡ [AUTO EXIT] 触发${isTakeProfit ? '止盈' : '止损'}：${reason} | 市场=${
                watch.marketTitle || ''
            } | 当前收益率=${percentPnlUsed.toFixed(2)}%（口径：Positions API；极低价仓位可能失真）| 阈值=${formatTpSlThresholdsZh(
                takeProfitPct,
                stopLossPct
            )} | 持仓=${size.toFixed(4)} | API初始成本≈$${
                Number.isFinite(pos.initialValue) ? (pos.initialValue as number).toFixed(4) : 'n/a'
            } 本地记录投入≈$${watch.trackedCostBasisUsd.toFixed(2)} 参考成本价≈$${
                refAvgPrice > 0 ? refAvgPrice.toFixed(6) : 'n/a'
            } 当前估值≈$${
                Number.isFinite(pos.currentValue) ? (pos.currentValue as number).toFixed(4) : 'n/a'
            } | tx=${txLog}`
        );

        const { proceedsUsd, soldTokens } = await marketSellTokensFOK(clobClient, watch.asset, size);
        const remaining = Math.max(0, size - soldTokens);
        const exitOk =
            remaining < ENV.AUTO_PROFIT_EXIT_CLEAR_WHEN_REMAINING_LT_TOKENS ||
            soldTokens >= size * 0.95;

        Logger.info(
            `📌 [AUTO EXIT] 平仓尝试结果 | 市场=${watch.marketTitle || ''} | 计划卖出=${size.toFixed(
                4
            )} 已卖出=${soldTokens.toFixed(4)} 剩余=${remaining.toFixed(
                4
            )} | 回收≈$${proceedsUsd.toFixed(2)} | ${exitOk ? '已基本平仓' : '未完全平仓，稍后重试'}`
        );

        // If we cannot sell any tokens due to missing orderbook / no bids, we should be careful:
        //  - For redeemable/mergeable positions, there may never be bids, so stopping tracking is OK.
        //  - For normal live positions, orderbook/bids can be temporarily missing; stopping tracking would
        //    prevent future re-tries even if PnL stays beyond TP/SL.
        if (soldTokens <= 0.0000001 && proceedsUsd <= 0.0000001) {
            Logger.warning(
                `🛑 [AUTO EXIT] 检测到无流动性/订单簿不可用：market=${
                    watch.marketTitle || ''
                } | sold≈${soldTokens.toFixed(4)} proceeds≈$${proceedsUsd.toFixed(2)}：停止跟踪 condition=${watch.conditionId.slice(
                    0,
                    10
                )}... asset=${watch.asset.slice(0, 12)}...`
            );
            const isProbablyNotSellable = !!(pos?.redeemable || pos?.mergeable);
            if (isProbablyNotSellable) {
                await clearBuyTrackingForAsset(watch.conditionId, watch.asset, watch.marketTitle);
                profitExitWatchesByPositionKey.delete(positionKey);
            } else {
                // Keep tracking so that after orderbook recovers we can retry selling.
                Logger.warning(
                    `🔁 [AUTO EXIT] 订单簿短暂缺失，保留跟踪以便冷却后重试：market=${
                        watch.marketTitle || ''
                    } | condition=${watch.conditionId.slice(0, 10)}... asset=${watch.asset.slice(0, 12)}...`
                );
            }
            continue;
        }

        if (exitOk) {
            await clearBuyTrackingForAsset(watch.conditionId, watch.asset, watch.marketTitle);
            profitExitWatchesByPositionKey.delete(positionKey);
            Logger.success(
                `✅ [AUTO EXIT] 平仓完成：sold=${soldTokens.toFixed(4)} tokens | proceeds≈$${proceedsUsd.toFixed(
                    2
                )} | remaining≈${remaining.toFixed(4)} | clearedTrackedBuy=true`
            );

            // 记录一次“自动止盈止损平仓”到成交流水，方便在 copy-tracking-export 做复盘
            // 说明：本 watch 以 conditionId+asset 维度聚合多个买入 txHash，因此此处按聚合结果写一条合成记录。
            const avgPrice = pos?.avgPrice;
            const realizedPnlUsd =
                Number.isFinite(avgPrice) && avgPrice !== undefined
                    ? proceedsUsd - soldTokens * (avgPrice as number)
                    : undefined;
            const autoExitType = isTakeProfit ? 'TAKE_PROFIT' : 'STOP_LOSS';
            const traderTxHash = txHashArr[0];
            await recordCopyTrackingFill({
                runMode: 'live',
                traderAddress: 'auto_profit_exit',
                traderDisplayName: 'AUTO_PROFIT_EXIT',
                marketTitle: watch.marketTitle || '',
                copyMode: CopyMode.FOLLOW,
                traderSide: 'BUY',
                mySide: 'SELL',
                traderAsset: watch.asset,
                myTradedAsset: watch.asset,
                executedUsdc: proceedsUsd,
                myTokenDelta: -soldTokens,
                traderTxHash,
                conditionId: watch.conditionId,
                realizedPnlUsd,
                autoExitType,
                autoExitReason: reason,
                autoExitPercentPnl: percentPnlUsed,
            });

            if (autoExitType === 'TAKE_PROFIT' && realizedPnlUsd !== undefined && realizedPnlUsd < 0) {
                Logger.error(
                    `❌ [AUTO EXIT] TAKE_PROFIT 触发但卖出仍亏损：realizedPnlUsd=${realizedPnlUsd.toFixed(
                        4
                    )} (可能仍存在估值/盘口差异或部分成交导致)`
                );
            }
        } else {
            Logger.warning(
                `⚠️ [AUTO EXIT] 平仓未完全成交：sold=${soldTokens.toFixed(4)} | remaining≈${remaining.toFixed(
                    4
                )}，将在冷却后重试`
            );
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
        const my_position = my_positions.find((position: UserPositionInterface) => {
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
            const traderTargetPosition =
                user_positions.find(
                    (position: UserPositionInterface) =>
                        position.conditionId === trade.conditionId && position.asset === targetAsset
                ) || user_position;

            // Skip BUY when market is effectively resolved / redeemable for the target leg.
            // This prevents buying right before settlement and then being immediately reconciled out.
            const targetCurPrice = traderTargetPosition?.curPrice;
            const resolvedByCurPrice =
                Number.isFinite(targetCurPrice) &&
                ((targetCurPrice as number) >= RESOLVED_HIGH ||
                    (targetCurPrice as number) <= RESOLVED_LOW);
            if (traderTargetPosition?.redeemable || resolvedByCurPrice) {
                Logger.warning(
                    `⏭ 跳过跟单：目标仓位已接近结算（redeemable=${traderTargetPosition?.redeemable ? 'true' : 'false'} curPrice=${
                        Number.isFinite(targetCurPrice) ? (targetCurPrice as number).toFixed(4) : 'n/a'
                    }）| market=${trade.title || trade.slug || ''} | condition=${trade.conditionId.slice(0, 10)}...`
                );
                Logger.separator();
                continue;
            }

            // Avoid buying when market is too close to end (liquidity often disappears).
            const skipMins = ENV.COPY_SKIP_FOLLOW_IF_ENDS_WITHIN_MINUTES;
            if (skipMins > 0) {
                const endTs = traderTargetPosition?.endDate
                    ? Date.parse(traderTargetPosition.endDate)
                    : NaN;
                if (Number.isFinite(endTs)) {
                    const minutesLeft = (endTs - Date.now()) / 60000;
                    if (minutesLeft >= 0 && minutesLeft < skipMins) {
                        Logger.warning(
                            `⏭ 跳过跟单：市场即将结束（距离结束 ${minutesLeft.toFixed(
                                1
                            )} 分钟 < 阈值 ${skipMins} 分钟）| market=${trade.title || trade.slug || ''} | condition=${trade.conditionId.slice(
                                0,
                                10
                            )}...`
                        );
                        Logger.separator();
                        continue;
                    }
                }
            }
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
            if (actualSide === 'BUY') {
                registerProfitExitWatch(
                    trade.transactionHash,
                    trade.conditionId,
                    tradedAsset,
                    trade.title || trade.slug || '',
                    executedUsdc
                );
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
        const my_position = my_positions.find((position: UserPositionInterface) => {
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
            if (actualSide === 'BUY') {
                for (const tr of agg.trades) {
                    const perTradeCost =
                        agg.totalUsdcSize > 0 ? executedUsdc * (tr.usdcSize / agg.totalUsdcSize) : 0;
                    registerProfitExitWatch(
                        tr.transactionHash,
                        agg.conditionId,
                        tradedAsset,
                        tr.title || tr.slug || agg.slug || '',
                        perTradeCost
                    );
                }
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
// Non-blocking auto profit exit loop (runs in background timer)
let autoProfitExitTimer: ReturnType<typeof setInterval> | undefined;
let autoProfitExitInFlight = false;

/**
 * Stop the trade executor gracefully
 */
export const stopTradeExecutor = () => {
    isRunning = false;
    Logger.info('交易执行器已请求关闭...');
    if (autoProfitExitTimer) {
        clearInterval(autoProfitExitTimer);
        autoProfitExitTimer = undefined;
    }
};

const tradeExecutor = async (clobClient: ClobClient) => {
    initDailyVolumeTracking();
    tradeExecutorStartTimestamp = Math.floor(Date.now() / 1000);
    Logger.success(`交易执行器就绪，正在监控 ${ENV.USER_ADDRESSES.length} 位交易员`);
    Logger.info(
        `  ⚙️ 自动止盈止损(ProfitExit)配置: ${ENV.AUTO_PROFIT_EXIT_ENABLED ? '启用' : '关闭'} | ` +
            `TP=${ENV.AUTO_PROFIT_EXIT_TAKE_PROFIT_PCT}% | SL=${ENV.AUTO_PROFIT_EXIT_STOP_LOSS_PCT}% | ` +
            `TP执行阈值>=${ENV.AUTO_PROFIT_EXIT_TAKE_PROFIT_MIN_EXEC_PNL_PCT}% | ` +
            `检查=${ENV.AUTO_PROFIT_EXIT_CHECK_INTERVAL_MS}ms | 冷却=${ENV.AUTO_PROFIT_EXIT_RETRY_COOLDOWN_MS}ms | ` +
            `清理阈值 < ${ENV.AUTO_PROFIT_EXIT_CLEAR_WHEN_REMAINING_LT_TOKENS} tokens`
    );
    Logger.info(
        `只执行启动后检测到的待执行单 (启动时间: ${formatBeijingDateTime(new Date(tradeExecutorStartTimestamp * 1000))})`
    );

    // Start auto profit exit in background to avoid blocking the main trading loop.
    if (ENV.AUTO_PROFIT_EXIT_ENABLED && ENV.AUTO_PROFIT_EXIT_CHECK_INTERVAL_MS > 0) {
        const tickMs = ENV.AUTO_PROFIT_EXIT_CHECK_INTERVAL_MS;
        autoProfitExitTimer = setInterval(() => {
            if (!isRunning) return;
            if (autoProfitExitInFlight) return;
            autoProfitExitInFlight = true;
            maybeAutoProfitExit(clobClient)
                .catch((e) => {
                    Logger.error(`⚠️ [AUTO EXIT] 自动止盈止损后台检查线程失败：${e}`);
                })
                .finally(() => {
                    autoProfitExitInFlight = false;
                });
        }, tickMs);
        Logger.info(
            `🧠 已启动自动止盈止损后台检查线程：每 ${tickMs}ms 检查一次（非阻塞）`
        );
    }
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

        // autoProfitExit handled by background timer

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
