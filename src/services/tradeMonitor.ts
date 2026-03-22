import { ENV, getCopyModeForTrader } from '../config/env';
import { copyModeLabelZhShort } from '../config/copyStrategy';
import { CopyMode } from '../config/copyStrategy';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import { resolveReverseAssetForCondition } from '../utils/conditionTokens';
import { normalizeClobAssetId, safeClobAssetFromApi } from '../utils/clobIds';
import { fetchPositionsForUser } from '../utils/dataApiCache';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import { formatBeijingDateTime } from '../utils/time';
import { isRetryableTransientError, transientBackoffMs, sleep } from '../utils/transientErrors';

/**
 * Fetch the opposite asset ID for a given conditionId and current asset.
 * Uses Gamma API (https://gamma-api.polymarket.com) for market data.
 */
const fetchOppositeAsset = async (conditionId: string, currentAsset: string): Promise<string> => {
    const cur = normalizeClobAssetId(currentAsset);
    Logger.info(`正在获取反向代币: conditionId=${conditionId.slice(0, 16)}..., asset=${cur.slice(0, 20)}...`);

    // Fast path: strictly trust tokens that belong to this condition.
    const strict = await resolveReverseAssetForCondition(conditionId, cur);
    if (strict.valid && strict.oppositeAsset) {
        Logger.info(`✅ 条件白名单校验命中反向代币: ${strict.oppositeAsset.slice(0, 20)}...`);
        return strict.oppositeAsset;
    }

    // Helper function to search for opposite in a market
    const findOppositeInMarket = (market: any): string | null => {
        // Gamma API 字段是 clobTokenIds，是一个 JSON 字符串数组
        if (market.clobTokenIds) {
            try {
                const tokenIds: string[] = JSON.parse(market.clobTokenIds);
                if (tokenIds.length >= 2) {
                    const opposite = tokenIds
                        .map((id) => normalizeClobAssetId(id))
                        .find((id: string) => id !== cur);
                    if (opposite) {
                        return opposite;
                    }
                }
            } catch {
                // 解析失败
            }
        }

        // 尝试 outcomeAssets
        if (Array.isArray(market.outcomeAssets) && market.outcomeAssets.length >= 2) {
            const opposite = market.outcomeAssets
                .map((a: string) => normalizeClobAssetId(a))
                .find((a: string) => a !== cur);
            if (opposite) {
                return opposite;
            }
        }

        return null;
    };

    // Method 1: 先尝试按 condition_ids 查询（勿用 condition_id，Gamma 会忽略并返回无关列表）
    let foundOpposite: string | null = null;

    try {
        const response = await fetchData(
            `https://gamma-api.polymarket.com/markets?condition_ids=${encodeURIComponent(conditionId)}`
        );

        if (response && typeof response === 'object') {
            const markets = Array.isArray(response) ? response : (response.markets || response.data || []);

            if (markets.length > 0) {
                // 检查第一个市场是否匹配
                const firstMarket = markets[0];
                const fc = String(firstMarket.conditionId || '').toLowerCase();
                if (fc && fc === conditionId.toLowerCase()) {
                    Logger.info(`   找到匹配市场: ${(firstMarket.question || '').slice(0, 50)}...`);
                    foundOpposite = findOppositeInMarket(firstMarket);
                    if (foundOpposite) {
                        const out = normalizeClobAssetId(foundOpposite);
                        Logger.info(`✅ Gamma API (condition_ids) 找到反向代币: ${out.slice(0, 20)}...`);
                        return out;
                    }
                }
            }
        }
    } catch (error) {
        Logger.warning(`Gamma API condition_ids 查询失败: ${error}`);
    }

    // Method 2: 使用 orderbook 获取 condition_id，再查询 Gamma API
    try {
        const orderbookResponse = await fetchData(
            `https://clob.polymarket.com/book?token_id=${encodeURIComponent(cur)}`
        );

        if (orderbookResponse && typeof orderbookResponse === 'object') {
            const marketConditionId = (orderbookResponse as any).market;
            if (marketConditionId) {
                Logger.info(`   orderbook 返回 condition_id: ${marketConditionId.slice(0, 20)}...`);

                const response = await fetchData(
                    `https://gamma-api.polymarket.com/markets?condition_ids=${encodeURIComponent(marketConditionId)}`
                );

                if (response && typeof response === 'object') {
                    const markets = Array.isArray(response) ? response : (response.markets || response.data || []);

                    for (const market of markets) {
                        foundOpposite = findOppositeInMarket(market);
                        if (foundOpposite) {
                            const out = normalizeClobAssetId(foundOpposite);
                            Logger.info(`✅ orderbook + Gamma API 找到反向代币: ${out.slice(0, 20)}...`);
                            return out;
                        }
                    }
                }
            }
        }
    } catch (error) {
        Logger.warning(`CLOB orderbook 查询失败: ${error}`);
    }

    // Method 3: 遍历市场列表查找包含当前 asset 的市场
    // 分批获取活跃市场
    try {
        const pageSize = 100;
        let offset = 0;
        let found = false;

        while (!found) {
            const response = await fetchData(
                `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${pageSize}&offset=${offset}`
            );

            if (response && typeof response === 'object') {
                const markets = Array.isArray(response) ? response : (response.markets || response.data || []);

                if (markets.length === 0) {
                    break; // 没有更多市场
                }

                for (const market of markets) {
                    // 检查这个市场是否包含我们的 conditionId 或者包含我们的 asset
                    if (market.conditionId === conditionId) {
                        Logger.info(`   遍历找到匹配市场: ${(market.question || '').slice(0, 50)}...`);
                        foundOpposite = findOppositeInMarket(market);
                        if (foundOpposite) {
                            const out = normalizeClobAssetId(foundOpposite);
                            Logger.info(`✅ 遍历市场列表找到反向代币: ${out.slice(0, 20)}...`);
                            return out;
                        }
                    }
                }

                offset += pageSize;

                // 防止无限循环，最多查询 500 个市场
                if (offset > 500) {
                    break;
                }
            } else {
                break;
            }
        }
    } catch (error) {
        Logger.warning(`遍历市场列表失败: ${error}`);
    }

    Logger.warning(`❌ 无法获取反向代币 for ${conditionId.slice(0, 16)}...`);
    return '';
};

// Only track trades AFTER bot starts (not historical trades)
const BOT_START_TIME = Math.floor(Date.now() / 1000);

const buildUserModels = () => {
    const addrs = ENV.USER_ADDRESSES;
    if (!addrs || addrs.length === 0) {
        throw new Error('跟单地址为空：请配置 USER_ADDRESSES_FOLLOW 和/或 USER_ADDRESSES_REVERSE');
    }
    return addrs.map((address) => ({
        address,
        UserActivity: getUserActivityModel(address),
        UserPosition: getUserPositionModel(address),
    }));
};

const init = async () => {
    const userModels = buildUserModels();
    const userAddresses = ENV.USER_ADDRESSES;
    const counts: number[] = [];
    for (const { address, UserActivity } of userModels) {
        const count = await UserActivity.countDocuments();
        counts.push(count);
    }
    Logger.clearLine();
    const copyModeTag = (a: string) => copyModeLabelZhShort(getCopyModeForTrader(a));
    Logger.dbConnection(userAddresses, counts, { copyModeTag });

    // Show your own positions first
    try {
        const myPositions = await fetchPositionsForUser(ENV.PROXY_WALLET);

        // Get current USDC balance
        const getMyBalance = (await import('../utils/getMyBalance')).default;
        const currentBalance = await getMyBalance(ENV.PROXY_WALLET);

        if (Array.isArray(myPositions) && myPositions.length > 0) {
            // Calculate your overall profitability and initial investment
            let totalValue = 0;
            let initialValue = 0;
            let weightedPnl = 0;
            myPositions.forEach((pos: any) => {
                const value = pos.currentValue || 0;
                const initial = pos.initialValue || 0;
                const pnl = pos.percentPnl || 0;
                totalValue += value;
                initialValue += initial;
                weightedPnl += value * pnl;
            });
            const myOverallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;

            // Get top 5 positions by profitability (PnL)
            const myTopPositions = myPositions
                .sort((a: any, b: any) => (b.percentPnl || 0) - (a.percentPnl || 0))
                .slice(0, 5);

            Logger.clearLine();
            Logger.myPositions(
                ENV.PROXY_WALLET,
                myPositions.length,
                myTopPositions,
                myOverallPnl,
                totalValue,
                initialValue,
                currentBalance
            );
        } else {
            Logger.clearLine();
            Logger.myPositions(ENV.PROXY_WALLET, 0, [], 0, 0, 0, currentBalance);
        }
    } catch (error) {
        Logger.error(`获取您的持仓失败: ${error}`);
    }

    // Show current positions count with details for traders you're copying
    const positionCounts: number[] = [];
    const positionDetails: any[][] = [];
    const profitabilities: number[] = [];
    for (const { address, UserPosition } of userModels) {
        const positions = await UserPosition.find().exec();
        positionCounts.push(positions.length);

        // Calculate overall profitability (weighted average by current value)
        let totalValue = 0;
        let weightedPnl = 0;
        positions.forEach((pos) => {
            const value = pos.currentValue || 0;
            const pnl = pos.percentPnl || 0;
            totalValue += value;
            weightedPnl += value * pnl;
        });
        const overallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;
        profitabilities.push(overallPnl);

        // Get top 3 positions by profitability (PnL)
        const topPositions = positions
            .sort((a, b) => (b.percentPnl || 0) - (a.percentPnl || 0))
            .slice(0, 3)
            .map((p) => p.toObject());
        positionDetails.push(topPositions);
    }
    Logger.clearLine();
    Logger.tradersPositions(userAddresses, positionCounts, positionDetails, profitabilities, {
        copyModeTag,
    });
};

const fetchTradeData = async () => {
    const userModels = buildUserModels();
    const proxyPositionsRows = await fetchPositionsForUser(ENV.PROXY_WALLET);
    const proxyPositionsArr = (Array.isArray(proxyPositionsRows) ? proxyPositionsRows : []) as any[];

    for (const { address, UserActivity, UserPosition } of userModels) {
        try {
            // Build cache for reverse trading:
            // key: `${conditionId}:${asset}` -> oppositeAsset
            // This must be asset-specific (YES/NO share the same conditionId).
            const oppositeAssetCache: Record<string, string> = {};
            const cacheKey = (conditionId: string, asset: string): string => `${conditionId}:${asset}`;

            const traderPositions = await fetchPositionsForUser(address);
            const traderPositionsArr = (Array.isArray(traderPositions) ? traderPositions : []) as any[];
            for (const pos of traderPositionsArr) {
                if (pos.conditionId && pos.asset && pos.oppositeAsset && pos.oppositeAsset !== pos.asset) {
                    const a = safeClobAssetFromApi(pos.asset, 'traderPositions.asset');
                    oppositeAssetCache[cacheKey(pos.conditionId, a)] = safeClobAssetFromApi(
                        pos.oppositeAsset,
                        'traderPositions.oppositeAsset'
                    );
                }
            }

            for (const pos of proxyPositionsArr) {
                if (pos.conditionId && pos.asset && pos.oppositeAsset) {
                    const a = safeClobAssetFromApi(pos.asset, 'positions.asset');
                    const key = cacheKey(pos.conditionId, a);
                    if (!oppositeAssetCache[key]) {
                        oppositeAssetCache[key] = safeClobAssetFromApi(
                            pos.oppositeAsset,
                            'positions.oppositeAsset'
                        );
                    }
                }
            }

            // Fetch trade activities from Polymarket API
            const apiUrl = `https://data-api.polymarket.com/activity?user=${address}&type=TRADE`;
            const activities = await fetchData(apiUrl);

            if (!Array.isArray(activities) || activities.length === 0) {
                continue;
            }

            // Process each activity
            for (const activity of activities) {
                // Only track trades AFTER bot started (ignore historical trades)
                if (activity.timestamp < BOT_START_TIME) {
                    continue;
                }

                // Check if this trade already exists in database
                const existingActivity = await UserActivity.findOne({
                    transactionHash: activity.transactionHash,
                }).exec();

                if (existingActivity) {
                    continue; // Already processed this trade
                }

                // Save new trade to database and immediately mark as "claimed" by bot
                // This prevents tradeExecutor from missing it and tradeMonitor from re-detecting it
                const assetNorm = safeClobAssetFromApi(activity.asset, 'activity.asset');
                let rawOpp: string | undefined =
                    safeClobAssetFromApi(activity.oppositeAsset, 'activity.oppositeAsset') ||
                    (activity.conditionId && assetNorm
                        ? oppositeAssetCache[cacheKey(activity.conditionId, assetNorm)]
                        : undefined);
                if (!rawOpp && activity.conditionId && assetNorm) {
                    rawOpp = await fetchOppositeAsset(activity.conditionId, assetNorm);
                }
                const newActivity = new UserActivity({
                    // 先按既有来源拿候选 oppositeAsset，随后做 conditionId 白名单校验
                    proxyWallet: activity.proxyWallet,
                    timestamp: activity.timestamp,
                    conditionId: activity.conditionId,
                    type: activity.type,
                    size: activity.size,
                    usdcSize: activity.usdcSize,
                    transactionHash: activity.transactionHash,
                    price: activity.price,
                    asset: assetNorm,
                    side: activity.side,
                    outcomeIndex: activity.outcomeIndex,
                    oppositeAsset: normalizeClobAssetId(rawOpp || '') || undefined,
                    title: activity.title,
                    slug: activity.slug,
                    icon: activity.icon,
                    eventSlug: activity.eventSlug,
                    outcome: activity.outcome,
                    name: activity.name,
                    pseudonym: activity.pseudonym,
                    bio: activity.bio,
                    profileImage: activity.profileImage,
                    profileImageOptimized: activity.profileImageOptimized,
                    bot: true,
                    botExcutedTime: 0,
                });

                if (newActivity.conditionId && newActivity.asset) {
                    const checked = await resolveReverseAssetForCondition(
                        newActivity.conditionId,
                        newActivity.asset,
                        newActivity.oppositeAsset || undefined
                    );
                    if (checked.valid && checked.oppositeAsset) {
                        newActivity.oppositeAsset = checked.oppositeAsset;
                    } else if (getCopyModeForTrader(address) === CopyMode.REVERSE) {
                        Logger.warning(
                            `[监控] oppositeAsset 未通过 condition 白名单校验: tx=${String(activity.transactionHash || '').slice(0, 12)}...`
                        );
                    }
                }

                await newActivity.save();
                const oc =
                    activity.outcome && String(activity.outcome).trim()
                        ? ` | Outcome: ${String(activity.outcome).trim()}`
                        : '';
                const monMode = getCopyModeForTrader(address);
                Logger.info(
                    `检测到 ${address.slice(0, 6)}...${address.slice(-4)} [${copyModeLabelZhShort(monMode)}] 的新交易${oc}`
                );
            }

            const positionsUpdate = traderPositionsArr;

            if (positionsUpdate.length > 0) {
                for (const position of positionsUpdate) {
                    // Update or create position
                    await UserPosition.findOneAndUpdate(
                        { asset: position.asset, conditionId: position.conditionId },
                        {
                            proxyWallet: position.proxyWallet,
                            asset: position.asset,
                            conditionId: position.conditionId,
                            size: position.size,
                            avgPrice: position.avgPrice,
                            initialValue: position.initialValue,
                            currentValue: position.currentValue,
                            cashPnl: position.cashPnl,
                            percentPnl: position.percentPnl,
                            totalBought: position.totalBought,
                            realizedPnl: position.realizedPnl,
                            percentRealizedPnl: position.percentRealizedPnl,
                            curPrice: position.curPrice,
                            redeemable: position.redeemable,
                            mergeable: position.mergeable,
                            title: position.title,
                            slug: position.slug,
                            icon: position.icon,
                            eventSlug: position.eventSlug,
                            outcome: position.outcome,
                            outcomeIndex: position.outcomeIndex,
                            oppositeOutcome: position.oppositeOutcome,
                            oppositeAsset: position.oppositeAsset,
                            endDate: position.endDate,
                            negativeRisk: position.negativeRisk,
                        },
                        { upsert: true }
                    );
                }
            }
        } catch (error) {
            Logger.error(
                `获取 ${address.slice(0, 6)}...${address.slice(-4)} 的数据时出错: ${error}`
            );
        }
    }
};

// Track if monitor should continue running
let isRunning = true;

/**
 * Stop the trade monitor gracefully
 */
export const stopTradeMonitor = () => {
    isRunning = false;
    Logger.info('交易监控已请求关闭...');
};

const tradeMonitor = async () => {
    let initStreak = 0;
    while (isRunning) {
        try {
            await init();
            initStreak = 0;
            break;
        } catch (initErr) {
            if (!isRunning) return;
            if (!isRetryableTransientError(initErr)) {
                Logger.error(`tradeMonitor init 失败（不可重试）: ${initErr}`);
                return;
            }
            initStreak += 1;
            const delayMs = transientBackoffMs(initStreak);
            Logger.warning(
                `tradeMonitor init 临时失败，约 ${(delayMs / 1000).toFixed(1)}s 后重试（第 ${initStreak} 次）: ${initErr}`
            );
            await sleep(delayMs);
        }
    }

    if (!isRunning) {
        Logger.info('交易监控已停止');
        return;
    }

    Logger.success(
        `正在监控 ${ENV.USER_ADDRESSES.length} 位交易员，每 ${ENV.FETCH_INTERVAL} 秒检查一次`
    );
    Logger.separator();
    Logger.info(
        `⏱ 仅跟踪 bot 启动后的新交易 (启动时间: ${formatBeijingDateTime(new Date(BOT_START_TIME * 1000))})`
    );
    Logger.separator();

    let pollStreak = 0;
    while (isRunning) {
        try {
            await fetchTradeData();
            pollStreak = 0;
        } catch (e) {
            if (!isRunning) break;
            if (isRetryableTransientError(e)) {
                pollStreak += 1;
                const delayMs = transientBackoffMs(pollStreak);
                Logger.warning(
                    `fetchTradeData 临时故障，约 ${(delayMs / 1000).toFixed(1)}s 后重试（连续 ${pollStreak} 次）: ${e}`
                );
                await sleep(delayMs);
                continue;
            }
            Logger.error(`fetchTradeData 出错: ${e}`);
        }
        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, ENV.FETCH_INTERVAL * 1000));
    }

    Logger.info('交易监控已停止');
};

export default tradeMonitor;
