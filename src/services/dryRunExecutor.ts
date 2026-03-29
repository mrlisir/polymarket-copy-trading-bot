import { ClobClient } from '@polymarket/clob-client';
import { ENV, buildCopyModeStartupSummary, getCopyModeForTrader } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import {
    CopyMode,
    getActualSide,
    calculateOrderSize,
    getTradeMultiplier,
    copyModeLabelZh,
    copyModeLabelZhShort,
    copyModeEnvColumnHint,
} from '../config/copyStrategy';
import { UserPositionInterface } from '../interfaces/User';
import {
    fetchPositionsForUser,
    fetchPositionsForUserForce,
    refreshPositionsForCopyWatchers,
} from '../utils/dataApiCache';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import { getCurPriceForAsset, refreshCurPriceMap } from '../utils/positionValuation';
import { buildEmailNotifyExtras, fetchOrderBookCached } from '../utils/postOrder';
import { resolveTokenMarkUsd } from '../utils/tokenMark';
import {
    RECONCILE_MIN_SELL_TOKENS,
    RESOLVED_HIGH,
    RESOLVED_LOW,
    anyTraderStillInMirror,
    copyModeForReconcileTraders,
    getMirrorAssetForReconcile,
    isMarketResolved,
    isReconcileTraderExitInGrace,
    loadCopiedConditionTraders,
    positionKey,
    touchReconcileTraderExitGrace,
} from './positionReconciliationCore';
import { fetchGammaSettlementInfoCached, gammaTokenLooksSettled } from '../utils/gammaSettlement';
import { resolveCopyOutcomeLabels } from '../utils/copyOutcomeLabels';
import { normalizeClobAssetId } from '../utils/clobIds';
import { formatTraderDisplayName, recordCopyTrackingFill } from './copyTrackingService';
import { formatBeijingDateTime } from '../utils/time';
import {
    notifyAutoProfitExit,
    notifyCopyRiskStop,
    notifyOrderSuccess,
    notifyPositionClear,
    notifyReverseTraderSellSkipped,
} from '../utils/emailNotifier';
import {
    evaluateReverseBuyPauseSkip,
    setReverseCopyBuyPause,
    setReverseCopyBuyPauseAfterAutoExit,
} from '../utils/reverseCopyBuyPause';
import { isRetryableTransientError, transientBackoffMs, sleep } from '../utils/transientErrors';
import {
    estimateSellProceedsFromBids,
    estimateSellPnlPctFromBids,
    formatTpSlThresholdsZh,
    makePositionKey,
    resolvePercentPnlForProfitExit,
    resolveRefAvgPriceForExit,
    shouldTriggerProfitExit,
} from '../utils/profitExit';

// Match postOrder.ts: minimum sell size in outcome tokens
const MIN_ORDER_SIZE_TOKENS = 1.0;

const maskAddrForMailDry = (a?: string): string | undefined => {
    if (!a) return undefined;
    return a.length >= 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
};

/**
 * Fetch the opposite asset ID for a given conditionId and current asset.
 * Simplified version for dry run.
 */
const fetchOppositeAssetDryRun = async (conditionId: string, currentAsset: string): Promise<string> => {
    try {
        // Try Gamma API with condition_ids（condition_id 会被忽略）
        const response = await fetchData(
            `https://gamma-api.polymarket.com/markets?condition_ids=${encodeURIComponent(conditionId)}`
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
                    `https://gamma-api.polymarket.com/markets?condition_ids=${encodeURIComponent(marketConditionId)}`
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

const buildUserActivityModels = () =>
    ENV.USER_ADDRESSES.map((address) => ({
        address,
        model: getUserActivityModel(address),
    }));

type TraderRiskState = {
    consecutiveLosses: number;
    cumulativeLossUsd: number;
    stopped: boolean;
    reason?: string;
};
const dryTraderRiskStates = new Map<string, TraderRiskState>();

const getDryRiskState = (userAddress: string): TraderRiskState => {
    const existing = dryTraderRiskStates.get(userAddress);
    if (existing) return existing;
    const fresh: TraderRiskState = {
        consecutiveLosses: 0,
        cumulativeLossUsd: 0,
        stopped: false,
    };
    dryTraderRiskStates.set(userAddress, fresh);
    return fresh;
};

const isDryTraderStopped = (userAddress: string): boolean =>
    ENV.COPY_STOP_ON_LOSS_ENABLED && getDryRiskState(userAddress).stopped;

const handleDryRiskAfterSell = async (userAddress: string, realizedPnlUsd: number): Promise<void> => {
    if (!ENV.COPY_STOP_ON_LOSS_ENABLED) return;
    const state = getDryRiskState(userAddress);
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
        `🛑 [模拟] 已停止跟单交易员 ${userAddress.slice(0, 6)}...${userAddress.slice(-4)} [${copyModeLabelZhShort(riskMode)} / ${copyModeEnvColumnHint(riskMode)}]：${state.reason}`
    );
    await notifyCopyRiskStop({
        trader: userAddress,
        reason: state.reason,
        consecutiveLosses: state.consecutiveLosses,
        cumulativeLossUsd: state.cumulativeLossUsd,
        mode: 'DRYRUN',
        copyMode: riskMode === CopyMode.REVERSE ? 'REVERSE' : 'FOLLOW',
        copyModeDetailZh: `${copyModeLabelZh(riskMode)} · .env 列 ${copyModeEnvColumnHint(riskMode)}`,
    });
};

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

    // Dry-run 里偶尔需要参考“是否可赎回/可合并”来决定是否继续跟踪。
    // 实盘 positions API 存在这些字段；模拟仓位可能没有，因此这里保持可选。
    redeemable?: boolean;
    mergeable?: boolean;
}

// 与 makePositionKey 一致（含 normalizeClobAssetId），否则 AUTO EXIT 的 watch 与模拟持仓 key 对不上
const posKey = (conditionId: string, asset: string) => makePositionKey(conditionId, asset);

interface OrderBookEntry {
    price: string;
    size: string;
}

// ============================================================
// Simulated account state (in-memory, reset on restart)
// ============================================================
let simulatedBalance = ENV.DRY_INITIAL_BALANCE;
const simulatedPositions: Map<string, SimulatedPosition> = new Map();

// Historical positions loaded from Polymarket at dry-run start.
// They are used only as baseline for reporting, NOT for sell availability during this run.
const baselinePositions: Map<string, SimulatedPosition> = new Map();

type DryProfitExitWatch = {
    positionKey: string; // lowercased "conditionId:asset"
    conditionId: string;
    asset: string;
    marketTitle: string;
    txHashes: Set<string>;
    trackedCostBasisUsd: number;
    registeredAt: number;
    lastMissingLogAt: number;
    lastExitAttemptAt: number;
    copyMode?: CopyMode;
    traderAddress?: string;
    positionFlatSince?: number;
};

const dryProfitExitWatchesByPositionKey: Map<string, DryProfitExitWatch> = new Map();
let lastDryProfitExitCheckAt = 0;

const removeDryProfitExitWatch = (positionKey: string): void => {
    dryProfitExitWatchesByPositionKey.delete(positionKey);
};

const registerDryProfitExitWatch = (
    txHash: string | undefined,
    conditionId: string,
    asset: string,
    marketTitle: string,
    executedUsdc: number,
    copyMode?: CopyMode,
    traderAddress?: string
): void => {
    if (!ENV.AUTO_PROFIT_EXIT_ENABLED) return;
    if (!txHash) return;
    const positionKey = makePositionKey(conditionId, asset);

    const existing = dryProfitExitWatchesByPositionKey.get(positionKey);
    if (existing) {
        const isNewTx = !existing.txHashes.has(txHash);
        existing.txHashes.add(txHash);
        if (isNewTx && Number.isFinite(executedUsdc) && executedUsdc > 0) {
            existing.trackedCostBasisUsd += executedUsdc;
        }
        if (!existing.marketTitle && marketTitle) existing.marketTitle = marketTitle;
        if (copyMode === CopyMode.REVERSE) {
            existing.copyMode = CopyMode.REVERSE;
        }
        if (traderAddress) {
            if (!existing.traderAddress) {
                existing.traderAddress = traderAddress;
            } else if (existing.traderAddress.toLowerCase() !== traderAddress.toLowerCase()) {
                Logger.warning(
                    `[AUTO EXIT DRYRUN] 同一 condition+asset 出现不同交易员地址，平仓后将无法归因熔断，已清空 traderAddress`
                );
                existing.traderAddress = undefined;
            }
        }
        return;
    }

    Logger.info(
        `🧷 [AUTO EXIT DRYRUN] watch registered: condition=${conditionId.slice(
            0,
            14
        )}... asset=${asset.slice(0, 12)}... tx=${txHash.slice(0, 6)}...${txHash.slice(-4)} | TP=${ENV.AUTO_PROFIT_EXIT_TAKE_PROFIT_PCT}% SL=${ENV.AUTO_PROFIT_EXIT_STOP_LOSS_PCT}%`
    );
    dryProfitExitWatchesByPositionKey.set(positionKey, {
        positionKey,
        conditionId,
        asset,
        marketTitle,
        txHashes: new Set([txHash]),
        trackedCostBasisUsd: Number.isFinite(executedUsdc) && executedUsdc > 0 ? executedUsdc : 0,
        registeredAt: Date.now(),
        lastMissingLogAt: 0,
        lastExitAttemptAt: 0,
        copyMode: copyMode === CopyMode.REVERSE ? CopyMode.REVERSE : undefined,
        traderAddress: traderAddress || undefined,
    });
};

const hasAnyTrackedBuy = async (conditionId: string, asset: string): Promise<boolean> => {
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

const maybeAutoProfitExitDryRun = async (clobClient: ClobClient): Promise<void> => {
    if (!ENV.AUTO_PROFIT_EXIT_ENABLED) return;
    const interval = ENV.AUTO_PROFIT_EXIT_CHECK_INTERVAL_MS;
    if (!interval || interval <= 0) return;
    if (dryProfitExitWatchesByPositionKey.size === 0) return;

    const now = Date.now();
    if (now - lastDryProfitExitCheckAt < interval) return;
    lastDryProfitExitCheckAt = now;

    const simulatedByKey = new Map<string, SimulatedPosition>();
    for (const [k, v] of simulatedPositions.entries()) {
        simulatedByKey.set(k.toLowerCase(), v);
    }

    for (const [positionKey, watch] of dryProfitExitWatchesByPositionKey.entries()) {
        const pos = simulatedByKey.get(positionKey);
        const size = pos?.size || 0;

        if (pos && size > 0) {
            watch.positionFlatSince = undefined;
        }

        if (!pos || size <= 0) {
            if (!watch.positionFlatSince) {
                watch.positionFlatSince = now;
            }
            if (now - watch.lastMissingLogAt > 5000) {
                watch.lastMissingLogAt = now;
                Logger.info(
                    `⏳ [AUTO EXIT DRYRUN] waiting positions reflect new buy: market=${
                        watch.marketTitle || ''
                    } | condition=${watch.conditionId.slice(0, 14)}... asset=${watch.asset.slice(
                        0,
                        12
                    )}... watchAge=${((now - watch.registeredAt) / 1000).toFixed(1)}s`
                );
            }

            const trackingGraceMs = Math.max(5000, ENV.AUTO_PROFIT_EXIT_CHECK_INTERVAL_MS * 5);
            const flatClearMs = Math.max(5000, ENV.AUTO_PROFIT_EXIT_FLAT_CLEAR_MS || 90000);
            if (
                now - watch.registeredAt >= trackingGraceMs &&
                watch.positionFlatSince &&
                now - watch.positionFlatSince >= flatClearMs
            ) {
                Logger.warning(
                    `🛑 [AUTO EXIT DRYRUN] 模拟仓已无该持仓 ≥${flatClearMs}ms，停止 AUTO EXIT 监控并清理 tracked BUY | market=${
                        watch.marketTitle || ''
                    } | condition=${watch.conditionId.slice(0, 10)}... asset=${watch.asset.slice(0, 12)}...`
                );
                for (const traderAddr of ENV.USER_ADDRESSES) {
                    const Model = getUserActivityModel(traderAddr);
                    await Model.updateMany(
                        {
                            conditionId: watch.conditionId,
                            $or: [{ asset: watch.asset }, { oppositeAsset: watch.asset }],
                            side: 'BUY',
                            bot: true,
                            myBoughtSize: { $exists: true, $gt: 0 },
                        },
                        { $set: { myBoughtSize: 0 } }
                    );
                }
                removeDryProfitExitWatch(positionKey);
                await notifyPositionClear({
                    runMode: 'DRYRUN',
                    reasonCode: 'DRYRUN_AUTO_EXIT_FLAT',
                    marketTitle: watch.marketTitle,
                    conditionId: watch.conditionId,
                    tokenId: watch.asset,
                    detailZh: `模拟仓已无该持仓 ≥${flatClearMs}ms，已停止 AUTO EXIT 并清理 Mongo tracked BUY。`,
                });
                continue;
            }

            if (now - watch.registeredAt >= trackingGraceMs) {
                try {
                    const trackedStillExists = await hasAnyTrackedBuy(watch.conditionId, watch.asset);
                    if (!trackedStillExists) {
                        Logger.warning(
                            `🛑 [AUTO EXIT DRYRUN] positions 已不在且 tracked BUY 已清零：停止跟踪 market=${
                                watch.marketTitle || ''
                            } | condition=${watch.conditionId.slice(0, 10)}... asset=${watch.asset.slice(
                                0,
                                12
                            )}...`
                        );
                        removeDryProfitExitWatch(positionKey);
                        await notifyPositionClear({
                            runMode: 'DRYRUN',
                            reasonCode: 'AUTO_EXIT_WATCH_STOP_NO_TRACKED',
                            marketTitle: watch.marketTitle,
                            conditionId: watch.conditionId,
                            tokenId: watch.asset,
                            detailZh: '模拟侧无持仓且 tracked BUY 已清零，停止 AUTO EXIT 监控。',
                        });
                    }
                } catch {
                    // keep watch
                }
            }
            continue;
        }

        const pxUsedRaw = await getValuationPriceUsd(pos.asset, clobClient, pos.conditionId);
        const pxUsed = pxUsedRaw > 0 ? pxUsedRaw : pos.avgPrice;
        const percentPnl = resolvePercentPnlForProfitExit({ ...pos, curPrice: pxUsed });
        if (percentPnl == null) continue;

        const { triggered, reason } = shouldTriggerProfitExit({
            percentPnl,
            takeProfitPct: ENV.AUTO_PROFIT_EXIT_TAKE_PROFIT_PCT,
            stopLossPct: ENV.AUTO_PROFIT_EXIT_STOP_LOSS_PCT,
        });
        if (!triggered) continue;

        if (now - watch.lastExitAttemptAt < ENV.AUTO_PROFIT_EXIT_RETRY_COOLDOWN_MS) {
            continue;
        }
        watch.lastExitAttemptAt = now;

        const takeProfitPct = ENV.AUTO_PROFIT_EXIT_TAKE_PROFIT_PCT;
        const stopLossPct = ENV.AUTO_PROFIT_EXIT_STOP_LOSS_PCT;
        const isTakeProfit = takeProfitPct > 0 && percentPnl >= takeProfitPct;
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
                `⏭️ [AUTO EXIT DRYRUN] 跳过止盈：无法估算成本均价（avg 无效且本地无有效投入记录）| market=${
                    watch.marketTitle || ''
                } | condition=${watch.conditionId.slice(0, 10)}... asset=${watch.asset.slice(0, 12)}...`
            );
            continue;
        }

        let preloadedOrderBook: { bids?: OrderBookEntry[] } | null = null;
        if (isTakeProfit && refAvgPrice > 0) {
            preloadedOrderBook = await fetchOrderBook(clobClient, pos.asset);
            const bids = preloadedOrderBook?.bids || [];
            if (watch.trackedCostBasisUsd > 0) {
                const estimate = estimateSellProceedsFromBids({ size, bids });
                const notion =
                    Number.isFinite(pos.size) &&
                    Number.isFinite(pos.avgPrice) &&
                    pos.size > 0 &&
                    pos.avgPrice > 0
                        ? pos.size * pos.avgPrice
                        : 0;
                const basisUsd = Math.max(watch.trackedCostBasisUsd, notion);
                const requiredProceeds = basisUsd * (1 + takeProfitPct / 100);
                if (!estimate || estimate.proceeds < requiredProceeds) {
                    Logger.warning(
                        `⏭️ [AUTO EXIT DRYRUN] 跳过止盈执行：预估可成交额≈$${estimate ? estimate.proceeds.toFixed(2) : 'n/a'} < 目标止盈额≈$${requiredProceeds.toFixed(
                            2
                        )}（成本基准≈$${basisUsd.toFixed(2)} = max(本地投入,size×均价)，TP=${takeProfitPct.toFixed(2)}%） | market=${watch.marketTitle || ''} | condition=${watch.conditionId.slice(
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
                    `⏭️ [AUTO EXIT DRYRUN] 跳过止盈执行：预估可成交Pnl=${execPnlPct != null ? execPnlPct.toFixed(2) + '%' : 'n/a'} < 最低执行阈值=${minExecPnlPct.toFixed(
                        2
                    )}% | market=${watch.marketTitle || ''} | condition=${watch.conditionId.slice(0, 10)}... asset=${watch.asset.slice(
                        0,
                        12
                    )}...`
                );
                continue;
            }
        }

        const avgLog =
            refAvgPrice > 0
                ? refAvgPrice.toFixed(4)
                : Number.isFinite(pos.avgPrice)
                  ? (pos.avgPrice as number).toFixed(4)
                  : 'n/a';
        Logger.warning(
            `⚡ [AUTO EXIT DRYRUN] 触发${isTakeProfit ? '止盈' : '止损'}：${reason} | 市场=${
                watch.marketTitle || ''
            } | 当前收益率=${percentPnl.toFixed(2)}% | 阈值=${formatTpSlThresholdsZh(
                takeProfitPct,
                stopLossPct
            )} | 持仓=${size.toFixed(4)} | 参考均价=${avgLog} 估值价=${pxUsed.toFixed(
                4
            )} 本地投入≈$${watch.trackedCostBasisUsd.toFixed(2)} | tx=${txLog}`
        );

        // Try to simulate a "market sell FOK-like" full exit using orderbook bids.
        const orderBook = preloadedOrderBook || (await fetchOrderBook(clobClient, pos.asset));
        if (orderBook?.bids && orderBook.bids.length > 0) {
            const sellTokens = pos.size;
            const result = simulateFillSell(sellTokens, orderBook.bids);
            const sold = result.tokens;
            const proceeds = result.proceeds;

            simulatedBalance += proceeds;
            const remaining = Math.max(0, pos.size - sold);

            // Remove position when effectively flat.
            if (
                remaining < ENV.AUTO_PROFIT_EXIT_CLEAR_WHEN_REMAINING_LT_TOKENS ||
                sold >= pos.size * 0.95
            ) {
                // 记录一次“自动止盈止损平仓”到成交流水，方便在 copy-tracking-export 做复盘
                const apiAvg =
                    typeof pos.avgPrice === 'number' && Number.isFinite(pos.avgPrice) && pos.avgPrice > 0
                        ? pos.avgPrice
                        : undefined;
                const costPxForPnl = refAvgPrice > 0 ? refAvgPrice : apiAvg;
                const realizedPnlUsd =
                    costPxForPnl !== undefined && sold > 0 ? proceeds - sold * costPxForPnl : undefined;
                const autoExitType =
                    percentPnl >= ENV.AUTO_PROFIT_EXIT_TAKE_PROFIT_PCT ? 'TAKE_PROFIT' : 'STOP_LOSS';
                const traderTxHash = Array.from(watch.txHashes)[0];
                const riskPnl =
                    realizedPnlUsd !== undefined && Number.isFinite(realizedPnlUsd) ? realizedPnlUsd : 0;
                if (watch.traderAddress) {
                    await handleDryRiskAfterSell(watch.traderAddress, riskPnl);
                }
                await recordCopyTrackingFill({
                    runMode: 'dryrun',
                    traderAddress: watch.traderAddress || 'auto_profit_exit',
                    traderDisplayName: watch.traderAddress
                        ? formatTraderDisplayName({}, watch.traderAddress)
                        : 'AUTO_PROFIT_EXIT',
                    marketTitle: watch.marketTitle || '',
                    slug: '',
                    conditionId: watch.conditionId,
                    copyMode: watch.copyMode ?? CopyMode.FOLLOW,
                    traderSide: 'BUY',
                    mySide: 'SELL',
                    traderAsset: watch.asset,
                    myTradedAsset: watch.asset,
                    executedUsdc: proceeds,
                    myTokenDelta: -sold,
                    traderTxHash,
                    realizedPnlUsd,
                    autoExitType,
                    autoExitReason: reason,
                    autoExitPercentPnl: percentPnl,
                });
                simulatedPositions.delete(posKey(pos.conditionId, pos.asset));
                removeDryProfitExitWatch(positionKey);
                if (watch.copyMode === CopyMode.REVERSE && ENV.COPY_REVERSE_PAUSE_NEW_BUYS_UNTIL_TRADER_FLAT) {
                    await setReverseCopyBuyPauseAfterAutoExit({
                        conditionId: watch.conditionId,
                        myAsset: watch.asset,
                    });
                }
                const exitFullDry =
                    remaining < ENV.AUTO_PROFIT_EXIT_CLEAR_WHEN_REMAINING_LT_TOKENS ||
                    sold >= pos.size * 0.95;
                await notifyAutoProfitExit({
                    runMode: 'DRYRUN',
                    kind: isTakeProfit ? 'TAKE_PROFIT' : 'STOP_LOSS',
                    marketTitle: watch.marketTitle || '',
                    conditionId: watch.conditionId,
                    tokenId: watch.asset,
                    soldTokens: sold,
                    proceedsUsd: proceeds,
                    plannedSize: size,
                    remainingTokens: remaining,
                    exitFull: exitFullDry,
                    realizedPnlUsd,
                    percentPnlAtTrigger: percentPnl,
                    triggerReason: reason,
                    copyMode: watch.copyMode === CopyMode.REVERSE ? 'REVERSE' : 'FOLLOW',
                    traderMask: maskAddrForMailDry(watch.traderAddress),
                });
            } else {
                const updated = simulatedPositions.get(posKey(pos.conditionId, pos.asset));
                if (updated) {
                    updated.size = updated.size - sold;
                }
                const costPxPart =
                    refAvgPrice > 0
                        ? refAvgPrice
                        : typeof pos.avgPrice === 'number' && Number.isFinite(pos.avgPrice) && pos.avgPrice > 0
                          ? pos.avgPrice
                          : undefined;
                const realizedPartial =
                    costPxPart !== undefined ? proceeds - sold * costPxPart : undefined;
                await notifyAutoProfitExit({
                    runMode: 'DRYRUN',
                    kind: isTakeProfit ? 'TAKE_PROFIT' : 'STOP_LOSS',
                    marketTitle: watch.marketTitle || '',
                    conditionId: watch.conditionId,
                    tokenId: watch.asset,
                    soldTokens: sold,
                    proceedsUsd: proceeds,
                    plannedSize: size,
                    remainingTokens: remaining,
                    exitFull: false,
                    realizedPnlUsd: realizedPartial,
                    percentPnlAtTrigger: percentPnl,
                    triggerReason: reason,
                    copyMode: watch.copyMode === CopyMode.REVERSE ? 'REVERSE' : 'FOLLOW',
                    traderMask: maskAddrForMailDry(watch.traderAddress),
                });
            }
        } else {
            // No orderbook/bids: mimic live behavior.
            // - redeemable/mergeable: likely cannot sell, so clear tracking.
            // - normal positions: keep watch so it can retry when bids recover.
            const isProbablyNotSellable = !!(pos?.redeemable || pos?.mergeable);
            if (isProbablyNotSellable) {
                const proceeds = pos.size * pxUsed;
                simulatedBalance += proceeds;
                simulatedPositions.delete(posKey(pos.conditionId, pos.asset));
                removeDryProfitExitWatch(positionKey);
                if (watch.copyMode === CopyMode.REVERSE && ENV.COPY_REVERSE_PAUSE_NEW_BUYS_UNTIL_TRADER_FLAT) {
                    await setReverseCopyBuyPauseAfterAutoExit({
                        conditionId: watch.conditionId,
                        myAsset: watch.asset,
                    });
                }
                await notifyPositionClear({
                    runMode: 'DRYRUN',
                    reasonCode: 'AUTO_EXIT_REDEEMABLE_NO_BID',
                    marketTitle: watch.marketTitle,
                    conditionId: watch.conditionId,
                    tokenId: watch.asset,
                    detailZh:
                        'Dry Run：AUTO EXIT 触发但无买盘，按可赎回/合并处理并删除模拟仓与 watch。',
                    proceedsUsd: proceeds,
                    soldTokens: pos.size,
                });
            } else {
                Logger.warning(
                    `🔁 [AUTO EXIT DRYRUN] 订单簿短暂缺失，保留跟踪以便冷却后重试：market=${watch.marketTitle || ''} | condition=${watch.conditionId.slice(
                        0,
                        10
                    )}... asset=${watch.asset.slice(0, 12)}...`
                );
            }
        }
    }
};

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
const dryDoubleSideBuyLocks = new Map<string, { asset: string; at: number }>();

const getDryLockedAsset = (conditionId: string): string | undefined => {
    const lock = dryDoubleSideBuyLocks.get(conditionId);
    if (!lock) return undefined;
    if (Date.now() - lock.at >= ENV.COPY_DOUBLE_SIDE_GUARD_LOCK_TTL_MS) {
        dryDoubleSideBuyLocks.delete(conditionId);
        return undefined;
    }
    return lock.asset;
};

const setDryConditionBuyLock = (conditionId: string, asset: string): void => {
    dryDoubleSideBuyLocks.set(conditionId, { asset, at: Date.now() });
    if (dryDoubleSideBuyLocks.size > 2000) {
        const now = Date.now();
        for (const [cid, entry] of dryDoubleSideBuyLocks) {
            if (now - entry.at >= ENV.COPY_DOUBLE_SIDE_GUARD_LOCK_TTL_MS) {
                dryDoubleSideBuyLocks.delete(cid);
            }
        }
    }
};

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

    // Match live sell behavior: walk bid levels from high -> low.
    const levels = (bids || [])
        .map((bid) => ({ price: parseFloat(bid.price), size: parseFloat(bid.size) }))
        .filter((x) => isFinite(x.price) && x.price > 0 && isFinite(x.size) && x.size > 0)
        .sort((a, b) => b.price - a.price);

    for (const level of levels) {
        if (remaining <= 0) break;
        const fill = Math.min(remaining, level.size);
        totalProceeds += fill * level.price;
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
    for (const { address, model } of buildUserActivityModels()) {
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
        const normalized = trades.map((t) => ({ ...t.toObject(), userAddress: address }));
        allTrades.push(
            ...normalized.filter((trade) => {
                if (!isDryTraderStopped(trade.userAddress)) return true;
                model.updateOne(
                    { _id: trade._id },
                    { $set: { bot: true, botExcutedTime: 2 } }
                ).exec();
                return false;
            })
        );
    }
    return allTrades;
};

// ============================================================
// Initialize simulated balance & positions from real data
// ============================================================

const initSimulatedAccount = async () => {
    console.log(`  模拟初始余额: $${ENV.DRY_INITIAL_BALANCE.toFixed(2)}`);

    if (ENV.DRY_START_FROM_REAL) {
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

    const copyMode = getCopyModeForTrader(trade.userAddress);
    const actualSide = getActualSide(trade.side || 'BUY', copyMode);
    const isReversed = copyMode === CopyMode.REVERSE;

    // Mark as processed (botExcutedTime: 2 means "dry-run processed")
    const UserActivity = getUserActivityModel(trade.userAddress);
    await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 2 } });
    if (isDryTraderStopped(trade.userAddress)) {
        console.log(`  ⏭  该交易员已触发亏损熔断，跳过`);
        console.log('─'.repeat(70));
        return;
    }

    console.log('\n' + '─'.repeat(70));
    const time = formatBeijingDateTime(new Date(trade.timestamp * 1000));
    const marketName = trade.title || trade.slug || trade.asset?.slice(0, 16) || 'unknown';
    console.log(`  📊 ${time}`);
    console.log(`  市场: ${marketName}`);
    console.log(`  交易员: ${trade.userAddress?.slice(0, 6)}...${trade.userAddress?.slice(-4)}`);
    console.log(
        `  跟单配置: ${copyModeLabelZh(copyMode)} · .env 列 ${copyModeEnvColumnHint(copyMode)}`
    );
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

    const user_positions = (await fetchPositionsForUserForce(trade.userAddress)) as UserPositionInterface[];
    const userPosList = Array.isArray(user_positions) ? user_positions : [];
    const outcomeLabels = resolveCopyOutcomeLabels(copyMode, trade, userPosList);
    console.log(`  📌 交易员 Outcome: ${outcomeLabels.traderOutcome}`);
    console.log(
        `  📌 我跟单 Outcome: ${outcomeLabels.myOutcome}（${outcomeLabels.modeHint}）`
    );

    const myHoldingKey = posKey(trade.conditionId, tradeAsset);

    // 风控：同一 condition 只跟一边。若已有另一侧持仓，则忽略后续另一边 BUY，避免两头买。
    if (actualSide === 'BUY') {
        const traderTargetPosition =
            userPosList.find((p) => p.conditionId === trade.conditionId && p.asset === tradeAsset) ||
            userPosList.find((p) => p.conditionId === trade.conditionId);
        const targetCurPrice = traderTargetPosition?.curPrice;
        const resolvedByCurPrice =
            Number.isFinite(targetCurPrice) &&
            ((targetCurPrice as number) >= RESOLVED_HIGH || (targetCurPrice as number) <= RESOLVED_LOW);
        if (traderTargetPosition?.redeemable || resolvedByCurPrice) {
            console.log(
                `  ⏭ 跳过跟单：目标仓位已接近结算（redeemable=${traderTargetPosition?.redeemable ? 'true' : 'false'} curPrice=${
                    Number.isFinite(targetCurPrice) ? (targetCurPrice as number).toFixed(4) : 'n/a'
                }）`
            );
            console.log('─'.repeat(70));
            return;
        }

        // 避免临近结束（endDate）买入：市场快结算后流动性经常消失（与实盘 tradeExecutor 一致）
        const skipMins = ENV.COPY_SKIP_FOLLOW_IF_ENDS_WITHIN_MINUTES;
        const endTsDry = traderTargetPosition?.endDate ? Date.parse(traderTargetPosition.endDate) : NaN;
        if (Number.isFinite(endTsDry)) {
            const minutesLeft = (endTsDry - Date.now()) / 60000;
            if (skipMins > 0 && minutesLeft >= 0 && minutesLeft < skipMins) {
                console.log(
                    `  ⏭ 跳过跟单：市场即将结束（距离结束 ${minutesLeft.toFixed(
                        1
                    )} 分钟 < 阈值 ${skipMins} 分钟）| market=${trade.title || trade.slug || ''} | condition=${trade.conditionId.slice(
                        0,
                        10
                    )}...`
                );
                console.log('─'.repeat(70));
                return;
            }
        }

        const lockedAsset = getDryLockedAsset(trade.conditionId);
        if (
            ENV.COPY_DOUBLE_SIDE_GUARD_MODE !== 'OFF' &&
            lockedAsset &&
            lockedAsset !== tradeAsset
        ) {
            console.log(
                `  ⏭  跳过: 内存锁已锁定同市场另一侧 (${lockedAsset.slice(0, 12)}...)，禁止两头买入`
            );
            console.log('─'.repeat(70));
            return;
        }
        const oppositeHeld = [...simulatedPositions.values()].find(
            (p) =>
                p.conditionId === trade.conditionId &&
                p.asset !== tradeAsset &&
                p.size > 0.0001
        );
        const shouldBlock =
            ENV.COPY_DOUBLE_SIDE_GUARD_MODE !== 'OFF' &&
            !!oppositeHeld &&
            (ENV.COPY_DOUBLE_SIDE_GUARD_MODE !== 'TRADER_ONLY' ||
                !!(oppositeHeld.openedBy && oppositeHeld.openedBy === trade.userAddress));
        if (shouldBlock && oppositeHeld) {
            console.log(
                `  ⏭  跳过: 同一市场已持有另一侧 (${oppositeHeld.outcome || oppositeHeld.asset.slice(0, 12)}...)，禁止两头买入`
            );
            console.log('─'.repeat(70));
            return;
        }
    }

    if (isReversed && actualSide === 'SELL' && !ENV.COPY_REVERSE_SYNC_TRADER_SELL) {
        console.log(
            `  ⏭  反买: COPY_REVERSE_SYNC_TRADER_SELL=false，跳过「交易员卖出 → 我方同步卖出」（与实盘 tradeExecutor 一致）`
        );
        await notifyReverseTraderSellSkipped({
            trader: trade.userAddress,
            title: trade.title || trade.slug || '',
            conditionId: trade.conditionId,
            traderOutcome: outcomeLabels.traderOutcome,
            myOutcome: outcomeLabels.myOutcome,
            modeHint: outcomeLabels.modeHint,
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            myTradedTokenId: normalizeClobAssetId(tradeAsset),
            txHash: trade.transactionHash,
            traderUsdcSize: trade.usdcSize,
            traderPrice: trade.price,
        });
        console.log('─'.repeat(70));
        return;
    }

    if (actualSide === 'BUY' && isReversed) {
        const pauseDry = evaluateReverseBuyPauseSkip({
            conditionId: trade.conditionId,
            myBuyAsset: tradeAsset,
            traderPositions: userPosList,
        });
        if (pauseDry.skip) {
            console.log(`  ⏭  ${pauseDry.detail}`);
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
        if (
            isReversed &&
            ENV.COPY_REVERSE_PAUSE_NEW_BUYS_UNTIL_TRADER_FLAT &&
            orderCalc.positionLimitReached
        ) {
            setReverseCopyBuyPause({
                conditionId: trade.conditionId,
                myAsset: tradeAsset,
                monitorTraderAsset: normalizeClobAssetId(trade.asset),
                reason: 'POSITION_MAX',
            });
        }
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
                if (isReversed) {
                    console.log(
                        `  ⚠️  无卖单，跳过（反买：对侧代币常无深度，与 REVERSE 列配置无关；可试正买或更长周期市场）`
                    );
                } else {
                    console.log(`  ⚠️  无卖单，跳过`);
                }
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
        setDryConditionBuyLock(trade.conditionId, tradeAsset);
        touchReconcileTraderExitGrace(
            trade.conditionId,
            tradeAsset,
            ENV.POSITION_RECONCILE_TRADER_EXIT_GRACE_MS
        );

        if (ENV.AUTO_PROFIT_EXIT_ENABLED) {
            registerDryProfitExitWatch(
                trade.transactionHash,
                trade.conditionId,
                tradeAsset,
                trade.title || trade.slug || '',
                result.spent,
                copyMode,
                trade.userAddress
            );
        }

        if (ENV.COPY_TRACKING_ENABLED && result.spent > 0) {
            await recordCopyTrackingFill({
                runMode: 'dryrun',
                traderAddress: trade.userAddress,
                traderDisplayName: formatTraderDisplayName(trade, trade.userAddress),
                marketTitle: trade.title || trade.slug || '',
                slug: trade.slug,
                conditionId: trade.conditionId,
                copyMode,
                traderSide: trade.side === 'SELL' ? 'SELL' : 'BUY',
                mySide: 'BUY',
                traderOutcome: outcomeLabels.traderOutcome,
                myOutcome: outcomeLabels.myOutcome,
                traderAsset: normalizeClobAssetId(trade.asset),
                myTradedAsset: normalizeClobAssetId(tradeAsset),
                executedUsdc: result.spent,
                myTokenDelta: result.tokens,
                traderTxHash: trade.transactionHash,
                activityObjectId: trade._id ? String(trade._id) : undefined,
            });
        }
        if (result.spent > 0) {
            const emailExtrasBuy = await buildEmailNotifyExtras(trade, trade.userAddress);
            await notifyOrderSuccess({
                side: 'BUY',
                dryRun: true,
                amountUsd: result.spent,
                tokens: result.tokens,
                price: result.avgPrice,
                tokenId: normalizeClobAssetId(tradeAsset),
                conditionId: trade.conditionId,
                trader: trade.userAddress,
                title: trade.title,
                txHash: trade.transactionHash,
                ...emailExtrasBuy,
            });
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

        const sellAssetKey = normalizeClobAssetId(tradeAsset);
        const UADry = getUserActivityModel(trade.userAddress);
        const previousBuysDry = await UADry.find({
            conditionId: trade.conditionId,
            $or: [{ asset: sellAssetKey }, { oppositeAsset: sellAssetKey }],
            side: 'BUY',
            bot: true,
            myBoughtSize: { $exists: true, $gt: 0 },
        }).exec();
        const totalBoughtTokensDry = previousBuysDry.reduce(
            (sum, buy) => sum + (buy.myBoughtSize || 0),
            0
        );

        let sellTokens: number;
        if (!user_position) {
            sellTokens = existing.size;
            if (totalBoughtTokensDry > 0) {
                sellTokens = Math.min(sellTokens, totalBoughtTokensDry);
            }
            console.log(`  📉 交易员已清仓该方向 → 模拟卖出全部持仓 ${sellTokens.toFixed(4)} tokens`);
        } else {
            const trader_position_before = user_position.size + trade.size;
            const trader_sell_percent = trade.size / trader_position_before;
            let baseSellSize: number;
            if (totalBoughtTokensDry > 0) {
                baseSellSize = totalBoughtTokensDry * trader_sell_percent;
                console.log(
                    `  📉 跟单卖出(与实盘一致，按 myBoughtSize 追踪): 合计 ${totalBoughtTokensDry.toFixed(4)} × ${(trader_sell_percent * 100).toFixed(2)}% → 基准 ${baseSellSize.toFixed(4)} tokens`
                );
            } else {
                baseSellSize = existing.size * trader_sell_percent;
                console.log(
                    `  📉 跟单卖出: 我方持仓 ${existing.size.toFixed(4)} × ${(trader_sell_percent * 100).toFixed(2)}% → 基准 ${baseSellSize.toFixed(4)} tokens（无 myBoughtSize 追踪，与 postOrder 无追踪分支一致）`
                );
            }
            const multiplier = getTradeMultiplier(ENV.COPY_STRATEGY_CONFIG, trade.usdcSize);
            sellTokens = baseSellSize * multiplier;
            console.log(
                `  📉 乘数 ${multiplier}x → ${sellTokens.toFixed(4)} tokens`
            );
        }

        if (totalBoughtTokensDry > 0) {
            sellTokens = Math.min(sellTokens, totalBoughtTokensDry);
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
        await handleDryRiskAfterSell(trade.userAddress, pnl);

        if (ENV.COPY_TRACKING_ENABLED && result.proceeds > 0) {
            await recordCopyTrackingFill({
                runMode: 'dryrun',
                traderAddress: trade.userAddress,
                traderDisplayName: formatTraderDisplayName(trade, trade.userAddress),
                marketTitle: trade.title || trade.slug || '',
                slug: trade.slug,
                conditionId: trade.conditionId,
                copyMode,
                traderSide: 'SELL',
                mySide: 'SELL',
                traderOutcome: outcomeLabels.traderOutcome,
                myOutcome: outcomeLabels.myOutcome,
                traderAsset: normalizeClobAssetId(trade.asset),
                myTradedAsset: normalizeClobAssetId(tradeAsset),
                executedUsdc: result.proceeds,
                myTokenDelta: -result.tokens,
                traderTxHash: trade.transactionHash,
                activityObjectId: trade._id ? String(trade._id) : undefined,
                realizedPnlUsd: pnl,
            });
        }
        if (result.proceeds > 0) {
            const emailExtrasSell = await buildEmailNotifyExtras(trade, trade.userAddress);
            await notifyOrderSuccess({
                side: 'SELL',
                dryRun: true,
                amountUsd: result.proceeds,
                tokens: result.tokens,
                price: result.avgPrice,
                tokenId: normalizeClobAssetId(tradeAsset),
                conditionId: trade.conditionId,
                trader: trade.userAddress,
                title: trade.title,
                txHash: trade.transactionHash,
                ...emailExtrasSell,
            });
        }

        existing.size -= result.tokens;
        if (existing.size <= 0.0001) {
            simulatedPositions.delete(myHoldingKey);
            if (isReversed && ENV.COPY_REVERSE_PAUSE_NEW_BUYS_UNTIL_TRADER_FLAT) {
                setReverseCopyBuyPause({
                    conditionId: trade.conditionId,
                    myAsset: normalizeClobAssetId(tradeAsset),
                    monitorTraderAsset: normalizeClobAssetId(trade.asset),
                    reason: 'COPY_SELL_FLAT',
                });
            }
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
    const entries = [...simulatedPositions.entries()];
    for (const [mapKey, pos] of entries) {
        if (actions >= maxPerRun) break;
        if (pos.size <= 0) continue;

        const involved = copiedMap.get(pos.conditionId);
        if (!involved?.size) continue;

        const pkey = positionKey(pos.conditionId, pos.asset);
        const lastAt = dryReconcileLastAt.get(pkey) || 0;
        if (now - lastAt < cooldownMs) continue;

        const { mode: copyMode, mixedFollowAndReverse } = copyModeForReconcileTraders(involved);
        if (mixedFollowAndReverse) {
            Logger.warning(
                '[模拟对账] 同一 condition 上的跟单交易员同时含正买与反买，镜像腿判定按 FOLLOW 处理'
            );
        }

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
            if (
                ENV.POSITION_RECONCILE_TRADER_EXIT_GRACE_MS > 0 &&
                isReconcileTraderExitInGrace(pos.conditionId, pos.asset)
            ) {
                Logger.info(
                    `[模拟对账] 跳过「交易员镜像腿已平」（建仓后宽限 ${ENV.POSITION_RECONCILE_TRADER_EXIT_GRACE_MS}ms 内）| ${(pos.title || pos.slug || pos.conditionId).slice(0, 48)}...`
                );
                continue;
            }
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
// Non-blocking auto profit exit loop (runs in background timer)
let autoProfitExitDryRunTimer: ReturnType<typeof setInterval> | undefined;
let autoProfitExitDryRunInFlight = false;
let positionsBackgroundRefreshDryRunTimer: ReturnType<typeof setInterval> | undefined;
let positionsBackgroundRefreshDryRunInFlight = false;

export const stopDryRunExecutor = () => {
    isRunning = false;
    Logger.info('模拟跟单已请求关闭...');
    if (autoProfitExitDryRunTimer) {
        clearInterval(autoProfitExitDryRunTimer);
        autoProfitExitDryRunTimer = undefined;
    }
    if (positionsBackgroundRefreshDryRunTimer) {
        clearInterval(positionsBackgroundRefreshDryRunTimer);
        positionsBackgroundRefreshDryRunTimer = undefined;
    }
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
    console.log(
        `    跟单地址:     正买 ${Object.values(ENV.TRADER_COPY_MODE_BY_ADDRESS).filter((m) => m === CopyMode.FOLLOW).length} 个 | 反买 ${Object.values(ENV.TRADER_COPY_MODE_BY_ADDRESS).filter((m) => m === CopyMode.REVERSE).length} 个`
    );
    console.log(`    ${buildCopyModeStartupSummary()}`);
    ENV.USER_ADDRESSES.forEach((addr, i) => {
        const m = getCopyModeForTrader(addr);
        console.log(
            `      ${i + 1}. ${addr.slice(0, 6)}...${addr.slice(-4)}  [${copyModeLabelZhShort(m)} · ${copyModeEnvColumnHint(m)}]`
        );
    });
    console.log(`    跟单策略:     ${ENV.COPY_STRATEGY_CONFIG.strategy}`);
    console.log(`    跟单比例:     ${ENV.COPY_STRATEGY_CONFIG.copySize}%`);
    console.log(`    最大单笔:     $${ENV.COPY_STRATEGY_CONFIG.maxOrderSizeUSD}`);
    console.log(`    最小单笔:     $${ENV.COPY_STRATEGY_CONFIG.minOrderSizeUSD}`);
    console.log(`    初始模拟余额: $${ENV.DRY_INITIAL_BALANCE.toFixed(2)}`);
    console.log(`    从真实持仓开始: ${ENV.DRY_START_FROM_REAL ? '是' : '否'}`);
    console.log(`    监控交易员:   ${ENV.USER_ADDRESSES.length} 个`);
    console.log(
        `    自动止盈止损: ${ENV.AUTO_PROFIT_EXIT_ENABLED ? '启用' : '关闭'} | TP=${ENV.AUTO_PROFIT_EXIT_TAKE_PROFIT_PCT}% | SL=${ENV.AUTO_PROFIT_EXIT_STOP_LOSS_PCT}% | ` +
            `检查=${ENV.AUTO_PROFIT_EXIT_CHECK_INTERVAL_MS}ms | 冷却=${ENV.AUTO_PROFIT_EXIT_RETRY_COOLDOWN_MS}ms | ` +
            `清理阈值 < ${ENV.AUTO_PROFIT_EXIT_CLEAR_WHEN_REMAINING_LT_TOKENS} tokens`
    );
    Logger.info(
        `⚙️ 自动止盈止损(ProfitExit)配置: ${ENV.AUTO_PROFIT_EXIT_ENABLED ? '启用' : '关闭'} | ` +
            `TP=${ENV.AUTO_PROFIT_EXIT_TAKE_PROFIT_PCT}% | SL=${ENV.AUTO_PROFIT_EXIT_STOP_LOSS_PCT}% | ` +
            `TP执行阈值>=${ENV.AUTO_PROFIT_EXIT_TAKE_PROFIT_MIN_EXEC_PNL_PCT}% | ` +
            `检查=${ENV.AUTO_PROFIT_EXIT_CHECK_INTERVAL_MS}ms | 冷却=${ENV.AUTO_PROFIT_EXIT_RETRY_COOLDOWN_MS}ms | ` +
            `清理阈值 < ${ENV.AUTO_PROFIT_EXIT_CLEAR_WHEN_REMAINING_LT_TOKENS} tokens`
    );
    if (ENV.POSITION_RECONCILE_INTERVAL_MS > 0) {
        console.log(
            `    仓位对账:     已启用（每 ${ENV.POSITION_RECONCILE_INTERVAL_MS}ms，与实盘同一套 POSITION_RECONCILE_*）`
        );
    } else {
        console.log(`    仓位对账:     关闭（设置 POSITION_RECONCILE_INTERVAL_MS>0 与实盘对齐）`);
    }
    console.log('');

    simulatedBalance = ENV.DRY_INITIAL_BALANCE;
    simulatedPositions.clear();
    baselinePositions.clear();
    processedIds.clear();
    dryReconcileLastAt.clear();
    dryReconcileOppositeCache.clear();
    dryDoubleSideBuyLocks.clear();
    dryTraderRiskStates.clear();

    await initSimulatedAccount();

    // Baseline for PnL: starting cash (simulated positions empty at cold start).
    // Valuation thereafter uses curPrice (+ orderbook fallback) in printAccountSummary.
    initialNetValue = simulatedBalance;

    console.log('');
    console.log('  ▶️  模拟跟单监控已启动，等待交易员新交易...\n');
    Logger.separator();

    // Start auto profit exit in background to avoid blocking the main dry-run loop.
    if (ENV.AUTO_PROFIT_EXIT_ENABLED && ENV.AUTO_PROFIT_EXIT_CHECK_INTERVAL_MS > 0) {
        const tickMs = ENV.AUTO_PROFIT_EXIT_CHECK_INTERVAL_MS;
        autoProfitExitDryRunTimer = setInterval(() => {
            if (!isRunning) return;
            if (autoProfitExitDryRunInFlight) return;
            autoProfitExitDryRunInFlight = true;
            maybeAutoProfitExitDryRun(clobClient)
                .catch((e) => {
                    Logger.error(`⚠️ [AUTO EXIT DRYRUN] 自动止盈止损后台检查线程失败：${e}`);
                })
                .finally(() => {
                    autoProfitExitDryRunInFlight = false;
                });
        }, tickMs);
        Logger.info(`🧠 已启动自动止盈止损后台检查线程：每 ${tickMs}ms 检查一次（非阻塞）`);
    }
    if (ENV.POSITIONS_BACKGROUND_REFRESH_INTERVAL_MS > 0) {
        const prMs = ENV.POSITIONS_BACKGROUND_REFRESH_INTERVAL_MS;
        positionsBackgroundRefreshDryRunTimer = setInterval(() => {
            if (!isRunning || positionsBackgroundRefreshDryRunInFlight) return;
            positionsBackgroundRefreshDryRunInFlight = true;
            refreshPositionsForCopyWatchers()
                .catch((e) => {
                    Logger.warning(`⚠️ [dryrun] 持仓后台刷新失败：${e}`);
                })
                .finally(() => {
                    positionsBackgroundRefreshDryRunInFlight = false;
                });
        }, prMs);
        Logger.info(
            `📡 [dryrun] 持仓后台异步刷新：每 ${prMs}ms 拉取代理+交易员最新 positions（与实盘 POSITIONS_BACKGROUND_REFRESH_INTERVAL_MS 一致）`
        );
    }

    let lastCheck = Date.now();
    let lastPositionsSnapshotAt = 0;
    let lastPositionReconcileAt = 0;
    const snapshotIntervalMs = ENV.DRY_POSITIONS_SNAPSHOT_INTERVAL_MS ?? 0;
    let dryTransientStreak = 0;

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
                        ENV.USER_ADDRESSES.length,
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
            dryTransientStreak = 0;
        } catch (error) {
            Logger.error(`模拟执行出错: ${error}`);
            if (isRetryableTransientError(error)) {
                dryTransientStreak += 1;
                const delayMs = transientBackoffMs(dryTransientStreak);
                Logger.warning(
                    `模拟轮询临时故障，约 ${(delayMs / 1000).toFixed(1)}s 后再试（连续 ${dryTransientStreak} 次）`
                );
                await sleep(delayMs);
            } else {
                dryTransientStreak = 0;
            }
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

        // autoProfitExit handled by background timer

        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await printAccountSummary(clobClient);
    Logger.info('模拟跟单已停止');
};

export default dryRunExecutor;
