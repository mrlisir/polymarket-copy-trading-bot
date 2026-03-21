import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import Logger from './logger';
import { calculateOrderSize, getTradeMultiplier, CopyMode } from '../config/copyStrategy';
import {
    getConditionTokensMetaCached,
    outcomeLabelForAsset,
    resolveReverseAssetForCondition,
} from './conditionTokens';
import { notifyOrderSuccess } from './emailNotifier';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const COPY_STRATEGY_CONFIG = ENV.COPY_STRATEGY_CONFIG;

// Orderbook caching (reduce getOrderBook API load & 404 spam)
const ORDERBOOK_CACHE_TTL_MS = ENV.ORDERBOOK_CACHE_TTL_MS;
const ORDERBOOK_CACHE_MAX_ENTRIES = ENV.ORDERBOOK_CACHE_MAX_ENTRIES;
const ORDERBOOK_MISSING_LOG_THROTTLE_MS = ENV.ORDERBOOK_MISSING_LOG_THROTTLE_MS;
const ORDER_PRICE_SLIPPAGE_USD = ENV.ORDER_PRICE_SLIPPAGE_USD;

type CachedOrderBook = {
    fetchedAt: number;
    // null means orderbook missing/404
    value: any | null;
};

type OrderBookEntry = {
    price: string;
    size: string;
};

// LRU-ish cache via insertion order (Map keeps insertion order)
const orderBookCache: Map<string, CachedOrderBook> = new Map();
const orderBookMissingLastLoggedAt: Map<string, number> = new Map();

const trimOrderBookCache = () => {
    while (orderBookCache.size > ORDERBOOK_CACHE_MAX_ENTRIES) {
        const firstKey = orderBookCache.keys().next().value;
        if (!firstKey) break;
        orderBookCache.delete(firstKey);
    }
};

/** Exported for shared mark/valuation (dry run + live portfolio log). */
export const fetchOrderBookCached = async (
    clobClient: ClobClient,
    tokenId: string
): Promise<any | null> => {
    const now = Date.now();
    const cached = orderBookCache.get(tokenId);
    if (cached && now - cached.fetchedAt <= ORDERBOOK_CACHE_TTL_MS) {
        return cached.value;
    }

    try {
        const orderBook = await clobClient.getOrderBook(tokenId);
        orderBookCache.set(tokenId, { fetchedAt: now, value: orderBook });
        trimOrderBookCache();
        return orderBook;
    } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) {
            orderBookCache.set(tokenId, { fetchedAt: now, value: null });
            trimOrderBookCache();

            const lastLoggedAt = orderBookMissingLastLoggedAt.get(tokenId) || 0;
            if (now - lastLoggedAt >= ORDERBOOK_MISSING_LOG_THROTTLE_MS) {
                orderBookMissingLastLoggedAt.set(tokenId, now);
                Logger.warning(
                    `⚠️  订单簿不存在 (404): token ${tokenId.slice(0, 12)}...（已限流）`
                );
            }
            return null;
        }

        throw err;
    }
};

// Legacy parameters (for backward compatibility in SELL logic)
const TRADE_MULTIPLIER = ENV.TRADE_MULTIPLIER;
const COPY_PERCENTAGE = ENV.COPY_PERCENTAGE;

// Polymarket minimum order sizes
const MIN_ORDER_SIZE_USD = 1.0; // Minimum order size in USD for BUY orders
const MIN_ORDER_SIZE_TOKENS = 1.0; // Minimum order size in tokens for SELL/MERGE orders

// Check if reverse mode is enabled
const isReverseMode = (): boolean => COPY_STRATEGY_CONFIG.copyMode === CopyMode.REVERSE;

// Get the correct position to check for reverse trading
// In reverse mode, we trade the OPPOSITE asset as the trader
// - Trader BUY YES → we BUY NO (oppositeAsset)
// - Trader SELL YES → we SELL NO (oppositeAsset)
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

const extractOrderError = (response: unknown): string | undefined => {
    if (!response) {
        return undefined;
    }

    if (typeof response === 'string') {
        return response;
    }

    if (typeof response === 'object') {
        const data = response as Record<string, unknown>;

        const directError = data.error;
        if (typeof directError === 'string') {
            return directError;
        }

        if (typeof directError === 'object' && directError !== null) {
            const nested = directError as Record<string, unknown>;
            if (typeof nested.error === 'string') {
                return nested.error;
            }
            if (typeof nested.message === 'string') {
                return nested.message;
            }
        }

        if (typeof data.errorMsg === 'string') {
            return data.errorMsg;
        }

        if (typeof data.message === 'string') {
            return data.message;
        }
    }

    return undefined;
};

const isInsufficientBalanceOrAllowanceError = (message: string | undefined): boolean => {
    if (!message) {
        return false;
    }
    const lower = message.toLowerCase();
    return lower.includes('not enough balance') || lower.includes('allowance');
};

const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number,
    userAddress: string,
    currentDailyVolume: number = 0
): Promise<number> => {
    const UserActivity = getUserActivityModel(userAddress);
    //Merge strategy
    if (condition === 'merge') {
        Logger.info('正在执行合并策略...');
        if (!my_position) {
            Logger.warning('无可合并的持仓');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return 0;
        }
        let remaining = my_position.size;
        let totalMergedUsdc = 0;

        // Check minimum order size
        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(`合并失败: 持仓数量过小 (${remaining.toFixed(2)} 个代币)`);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return 0;
        }

        let retry = 0;
        let abortDueToFunds = false;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            let orderBook;
            try {
                orderBook = await fetchOrderBookCached(clobClient, trade.asset);
            } catch (orderBookError: unknown) {
                retry += 1;
                Logger.warning(`订单簿查询失败 (${retry}/${RETRY_LIMIT}): ${orderBookError}`);
                continue;
            }

            if (!orderBook) {
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            if (!orderBook.bids || orderBook.bids.length === 0) {
                Logger.warning('订单簿中无买方报价');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const bids = orderBook.bids as OrderBookEntry[];
            const maxPriceBid = bids.reduce(
                (max: OrderBookEntry, bid: OrderBookEntry) =>
                    parseFloat(bid.price) > parseFloat(max.price) ? bid : max,
                bids[0]
            );

            Logger.info(`最优买价: ${maxPriceBid.size} @ $${maxPriceBid.price}`);
            let order_arges;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: remaining,
                    price: parseFloat(maxPriceBid.price),
                };
            } else {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: parseFloat(maxPriceBid.size),
                    price: parseFloat(maxPriceBid.price),
                };
            }
            // Order args logged internally
            const signedOrder = await clobClient.createMarketOrder(order_arges);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                const proceeds = order_arges.amount * order_arges.price;
                totalMergedUsdc += proceeds;
                Logger.orderResult(
                    true,
                    `Sold ${order_arges.amount} tokens at $${order_arges.price}`
                );
                remaining -= order_arges.amount;
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.warning(
                        `订单被拒绝: ${errorMessage || '余额或授权不足'}`
                    );
                    Logger.warning(
                        '跳过剩余尝试。请充值或运行 `npm run check-allowance` 后重试。'
                    );
                    break;
                }
                retry += 1;
                Logger.warning(
                    `订单失败 (第 ${retry}/${RETRY_LIMIT} 次尝试)${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        }
        if (abortDueToFunds) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: RETRY_LIMIT }
            );
            return 0;
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
        return totalMergedUsdc;
    } else if (condition === 'buy') {
        //Buy strategy
        // In REVERSE mode, 'buy' means trader sold → we buy opposite side
        if (isReverseMode() && trade.conditionId) {
            const resolved = await resolveReverseAssetForCondition(
                trade.conditionId,
                trade.asset,
                trade.oppositeAsset
            );
            if (resolved.valid && resolved.oppositeAsset) {
                trade.oppositeAsset = resolved.oppositeAsset;
            }
        }
        const tradeAsset = getPositionAsset(trade);
        if (isReverseMode()) {
            Logger.info(`🔄 反买模式: 交易员 ${trade.side} → 我买入反向资产 ${tradeAsset}`);
            Logger.info(`   原始订单: ${trade.side} $${trade.usdcSize.toFixed(2)} @ $${trade.price}`);
            const leg =
                trade.outcome && String(trade.outcome).trim()
                    ? String(trade.outcome).trim()
                    : '交易员该笔合约腿';
            Logger.info(
                `📌 反买说明：你在 Polymarket 上买到的是「对侧 outcome」合约（与 activity 里 ${leg} 相反），不是跟交易员同方向；若要同向买 ${leg}，请把 COPY_MODE 设为 FOLLOW。`
            );
        }
        // Safety: in REVERSE mode we must buy the OPPOSITE token.
        // If oppositeAsset is missing/invalid, do not fall back to the same asset.
        if (isReverseMode() && (!trade.oppositeAsset || trade.oppositeAsset === trade.asset)) {
            Logger.warning('⚠️ 反买模式缺少有效 oppositeAsset（或与原 asset 相同），本笔跳过，避免执行成跟随单');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return 0;
        }

        // Gamma 核对：二元市场以 clobTokenIds 为准，避免 UI 与 Data API 标反时误以为「同腿」
        if (isReverseMode() && trade.conditionId) {
            try {
                const meta = await getConditionTokensMetaCached(trade.conditionId);
                const traderLeg = outcomeLabelForAsset(meta.tokenIds, meta.outcomes, trade.asset);
                const myLeg = outcomeLabelForAsset(meta.tokenIds, meta.outcomes, tradeAsset);
                if (traderLeg || myLeg) {
                    Logger.info(
                        `🔬 Gamma 核对 outcome: 交易员本笔「${traderLeg ?? '?'}」→ 我方下单「${myLeg ?? '?'}」（应与前者相反；若 Polymarket 仍显示同侧，请对照 token_id / 交易哈希）`
                    );
                }
            } catch {
                // ignore
            }
        }

        Logger.info(`您的余额: $${my_balance.toFixed(2)}`);
        Logger.info(`交易员买入: $${trade.usdcSize.toFixed(2)}`);

        // Get current position size for position limit checks
        const currentPositionValue = my_position ? my_position.size * my_position.avgPrice : 0;

        // Show daily volume status if limit is configured
        const dailyLimit = COPY_STRATEGY_CONFIG.maxDailyVolumeUSD;
        if (dailyLimit) {
            const dailyUsed = currentDailyVolume;
            const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);
            Logger.info(
                `📅 今日限额: $${dailyLimit.toFixed(2)} | 已用: $${dailyUsed.toFixed(2)} | 剩余: $${dailyRemaining.toFixed(2)}`
            );
        }

        // Use new copy strategy system
        const orderCalc = calculateOrderSize(
            COPY_STRATEGY_CONFIG,
            trade.usdcSize,
            my_balance,
            currentPositionValue,
            currentDailyVolume
        );

        // Log the calculation reason with daily volume detail
        if (orderCalc.dailyVolumeStatus) {
            const dvs = orderCalc.dailyVolumeStatus;
            if (dvs.blocked) {
                Logger.warning(
                    `⛔ 每日限额已用完: $${dvs.used.toFixed(2)} / $${dvs.limit.toFixed(2)} — 跳过交易`
                );
            } else if (orderCalc.finalAmount === 0) {
                Logger.warning(
                    `⛔ 每日限额即将耗尽: $${dvs.remaining.toFixed(2)} 剩余金额不足最小交易额 — 跳过`
                );
            }
        }
        Logger.info(`📊 ${orderCalc.reason}`);

        // Check if order should be executed
        if (orderCalc.finalAmount === 0) {
            Logger.warning(`❌ 无法执行: ${orderCalc.reason}`);
            if (orderCalc.belowMinimum) {
                Logger.warning(`💡 请增大 COPY_SIZE 或等待更大交易`);
            }
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return 0;
        }

        let remaining = orderCalc.finalAmount;

        let retry = 0;
        let abortDueToFunds = false;
        let totalBoughtTokens = 0; // Track total tokens bought for this trade
        let totalSpentUsdc = 0; // Track total USDC spent for this trade

        while (remaining > 0 && retry < RETRY_LIMIT) {
            let orderBook;
            try {
                orderBook = await fetchOrderBookCached(clobClient, tradeAsset);
            } catch (orderBookError: unknown) {
                retry += 1;
                Logger.warning(
                    `订单簿查询失败 (第 ${retry}/${RETRY_LIMIT} 次): ${orderBookError}`
                );
                continue;
            }

            if (!orderBook) {
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            if (!orderBook.asks || orderBook.asks.length === 0) {
                Logger.warning('No asks available in order book');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const asks = orderBook.asks as OrderBookEntry[];
            const minPriceAsk = asks.reduce(
                (min: OrderBookEntry, ask: OrderBookEntry) =>
                    parseFloat(ask.price) < parseFloat(min.price) ? ask : min,
                asks[0]
            );

            Logger.info(`最优卖价: ${minPriceAsk.size} @ $${minPriceAsk.price}`);
            if (parseFloat(minPriceAsk.price) - ORDER_PRICE_SLIPPAGE_USD > trade.price) {
                Logger.warning('价格滑点过大 — 跳过此次交易');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            // Check if remaining amount is below minimum before creating order
            if (remaining < MIN_ORDER_SIZE_USD) {
                Logger.info(
                    `剩余金额 ($${remaining.toFixed(2)}) 低于最小值 — 完成此次交易`
                );
                await UserActivity.updateOne(
                    { _id: trade._id },
                    { bot: true, myBoughtSize: totalBoughtTokens }
                );
                break;
            }

            const maxOrderSize = parseFloat(minPriceAsk.size) * parseFloat(minPriceAsk.price);
            const orderSize = Math.min(remaining, maxOrderSize);

            // Polymarket market BUY requires >= $1 notional.
            // If top ask depth only allows < $1 (e.g. 73.23 @ $0.01 => $0.73),
            // retrying is pointless unless book depth changes; skip this trade gracefully.
            if (orderSize < MIN_ORDER_SIZE_USD) {
                Logger.warning(
                    `当前盘口可成交金额仅 $${orderSize.toFixed(2)}，低于最小下单 $${MIN_ORDER_SIZE_USD.toFixed(2)}，跳过本笔`
                );
                await UserActivity.updateOne(
                    { _id: trade._id },
                    { bot: true, myBoughtSize: totalBoughtTokens }
                );
                break;
            }

            const order_arges = {
                side: Side.BUY,
                tokenID: tradeAsset,
                amount: orderSize,
                price: parseFloat(minPriceAsk.price),
            };

            Logger.info(
                `正在下单: $${orderSize.toFixed(2)} @ $${minPriceAsk.price} (余额: $${my_balance.toFixed(2)})`
            );
            // Order args logged internally
            const signedOrder = await clobClient.createMarketOrder(order_arges);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                const tokensBought = order_arges.amount / order_arges.price;
                totalBoughtTokens += tokensBought;
                const usdcSpent = order_arges.amount;
                totalSpentUsdc += usdcSpent;
                Logger.orderResult(
                    true,
                    `买入成功: $${order_arges.amount.toFixed(2)} @ $${order_arges.price} (${tokensBought.toFixed(2)} 个代币)`
                );
                await notifyOrderSuccess({
                    side: 'BUY',
                    amountUsd: order_arges.amount,
                    tokens: tokensBought,
                    price: order_arges.price,
                    tokenId: tradeAsset,
                    conditionId: trade.conditionId,
                    trader: userAddress,
                    title: trade.title,
                    txHash: trade.transactionHash,
                });
                remaining -= order_arges.amount;
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.warning(
                        `订单被拒绝: ${errorMessage || '余额或授权不足'}`
                    );
                    Logger.warning(
                        '跳过剩余尝试。请充值或运行 `npm run check-allowance` 后重试。'
                    );
                    break;
                }
                retry += 1;
                Logger.warning(
                    `订单失败 (第 ${retry}/${RETRY_LIMIT} 次尝试)${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        }
        if (abortDueToFunds) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: RETRY_LIMIT, myBoughtSize: totalBoughtTokens }
            );
            return 0;
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: retry, myBoughtSize: totalBoughtTokens }
            );
        } else {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, myBoughtSize: totalBoughtTokens }
            );
        }

        // Log the tracked purchase for later sell reference
        if (totalBoughtTokens > 0) {
            Logger.info(
                `📝 已记录购买: ${totalBoughtTokens.toFixed(2)} 个代币，用于后续卖出计算`
            );
        }
        return totalSpentUsdc;
    } else if (condition === 'sell') {
        //Sell strategy
        // In REVERSE mode, 'sell' means trader bought → we sell our opposite position
        Logger.info('正在执行卖出策略...');
        let remaining = 0;
        if (!my_position) {
            Logger.warning('无可卖出的持仓');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return 0;
        }

        if (isReverseMode() && trade.conditionId) {
            const resolved = await resolveReverseAssetForCondition(
                trade.conditionId,
                trade.asset,
                trade.oppositeAsset
            );
            if (resolved.valid && resolved.oppositeAsset) {
                trade.oppositeAsset = resolved.oppositeAsset;
            }
        }

        // Determine which asset we're selling
        // In REVERSE mode: we sell oppositeAsset (we hold the opposite tokens)
        // In FOLLOW mode: we sell the same asset as trader
        const sellAsset = isReverseMode() ? (trade.oppositeAsset || trade.asset) : trade.asset;
        // Safety: in REVERSE mode we must sell the OPPOSITE token.
        if (isReverseMode() && (!trade.oppositeAsset || trade.oppositeAsset === trade.asset)) {
            Logger.warning('⚠️ 反买模式缺少有效 oppositeAsset（或与原 asset 相同），本笔跳过，避免执行成跟随单');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return 0;
        }

        // Get all previous BUY trades for this asset to calculate total bought
        // In REVERSE mode: query by sellAsset (the opposite token we bought)
        // In FOLLOW mode: query by trade.asset (the same token as trader)
        const previousBuys = await UserActivity.find({
            asset: sellAsset,
            conditionId: trade.conditionId,
            side: 'BUY',
            bot: true,
            myBoughtSize: { $exists: true, $gt: 0 },
        }).exec();

        const totalBoughtTokens = previousBuys.reduce(
            (sum, buy) => sum + (buy.myBoughtSize || 0),
            0
        );

        if (totalBoughtTokens > 0) {
            Logger.info(
                `📊 发现 ${previousBuys.length} 笔历史买入记录: ${totalBoughtTokens.toFixed(2)} 个代币`
            );
        }

        if (!user_position) {
            // Trader sold entire position - we sell entire position too
            remaining = my_position.size;
            Logger.info(
                `Trader closed entire position → Selling all your ${remaining.toFixed(2)} tokens`
            );
        } else {
            // Calculate the % of position the trader is selling
            const trader_sell_percent = trade.size / (user_position.size + trade.size);
            const trader_position_before = user_position.size + trade.size;

            Logger.info(
                `持仓对比: 交易员有 ${trader_position_before.toFixed(2)} 个代币，您有 ${my_position.size.toFixed(2)} 个代币`
            );
            Logger.info(
                `交易员卖出: ${trade.size.toFixed(2)} 个代币 (占其仓位的 ${(trader_sell_percent * 100).toFixed(2)}%)`
            );

            // Use tracked bought tokens if available, otherwise fallback to current position
            let baseSellSize;
            if (totalBoughtTokens > 0) {
                baseSellSize = totalBoughtTokens * trader_sell_percent;
                Logger.info(
                    `Calculating from tracked purchases: ${totalBoughtTokens.toFixed(2)} × ${(trader_sell_percent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} tokens`
                );
            } else {
                baseSellSize = my_position.size * trader_sell_percent;
                Logger.warning(
                    `未找到追踪购买记录，使用当前持仓: ${my_position.size.toFixed(2)} × ${(trader_sell_percent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} 个代币`
                );
            }

            // Apply tiered or single multiplier based on trader's order size (symmetrical with BUY logic)
            const multiplier = getTradeMultiplier(COPY_STRATEGY_CONFIG, trade.usdcSize);
            remaining = baseSellSize * multiplier;

            if (multiplier !== 1.0) {
                Logger.info(
                    `应用 ${multiplier}x 乘数 (基于交易员 $${trade.usdcSize.toFixed(2)} 订单): ${baseSellSize.toFixed(2)} → ${remaining.toFixed(2)} 个代币`
                );
            }
        }

        // Check minimum order size
        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(
                `❌ 无法执行: 卖出数量 ${remaining.toFixed(2)} 个代币低于最低限制 (${MIN_ORDER_SIZE_TOKENS} 个代币)`
            );
            Logger.warning(`💡 这通常发生在持仓数量过小或不对称时`);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return 0;
        }

        // Cap sell amount to available position size
        if (remaining > my_position.size) {
            Logger.warning(
                `⚠️  计算卖出数量 ${remaining.toFixed(2)} 个代币 > 您的持仓 ${my_position.size.toFixed(2)} 个代币`
            );
            Logger.warning(`已限制为最大可用数量: ${my_position.size.toFixed(2)} 个代币`);
            remaining = my_position.size;
        }

        let retry = 0;
        let abortDueToFunds = false;
        let totalSoldTokens = 0; // Track total tokens sold
        let totalSoldUsdc = 0; // Track total USDC proceeds

        while (remaining > 0 && retry < RETRY_LIMIT) {
            let orderBook;
            try {
                // In REVERSE mode, sellAsset is the opposite token — fetch its orderbook
                // In FOLLOW mode, sellAsset === trade.asset so this is equivalent
                orderBook = await fetchOrderBookCached(clobClient, sellAsset);
            } catch (orderBookError: unknown) {
                retry += 1;
                Logger.warning(`订单簿查询失败 (${retry}/${RETRY_LIMIT}): ${orderBookError}`);
                continue;
            }

            if (!orderBook) {
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            if (!orderBook.bids || orderBook.bids.length === 0) {
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                Logger.warning('订单簿中无买方报价');
                break;
            }

            const bids = orderBook.bids as OrderBookEntry[];
            const maxPriceBid = bids.reduce(
                (max: OrderBookEntry, bid: OrderBookEntry) =>
                    parseFloat(bid.price) > parseFloat(max.price) ? bid : max,
                bids[0]
            );

            Logger.info(`最优买价: ${maxPriceBid.size} @ $${maxPriceBid.price}`);

            if (remaining < MIN_ORDER_SIZE_TOKENS) {
                Logger.info(
                    `剩余数量 (${remaining.toFixed(2)} 个代币) 低于最小值 — 完成此次交易`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const sellAmount = Math.min(remaining, parseFloat(maxPriceBid.size));

            if (sellAmount < MIN_ORDER_SIZE_TOKENS) {
                Logger.info(
                    `订单数量 (${sellAmount.toFixed(2)} 个代币) 低于最小值 — 完成此次交易`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const order_arges = {
                side: Side.SELL,
                tokenID: sellAsset,
                amount: sellAmount,
                price: parseFloat(maxPriceBid.price),
            };
            // Order args logged internally
            const signedOrder = await clobClient.createMarketOrder(order_arges);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                totalSoldTokens += order_arges.amount;
                totalSoldUsdc += order_arges.amount * order_arges.price;
                Logger.orderResult(
                    true,
                    `卖出成功: ${order_arges.amount} 个代币 @ $${order_arges.price}`
                );
                await notifyOrderSuccess({
                    side: 'SELL',
                    amountUsd: order_arges.amount * order_arges.price,
                    tokens: order_arges.amount,
                    price: order_arges.price,
                    tokenId: sellAsset,
                    conditionId: trade.conditionId,
                    trader: userAddress,
                    title: trade.title,
                    txHash: trade.transactionHash,
                });
                remaining -= order_arges.amount;
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.warning(
                        `订单被拒绝: ${errorMessage || '余额或授权不足'}`
                    );
                    Logger.warning(
                        '跳过剩余尝试。请充值或运行 `npm run check-allowance` 后重试。'
                    );
                    break;
                }
                retry += 1;
                Logger.warning(
                    `订单失败 (第 ${retry}/${RETRY_LIMIT} 次尝试)${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        }

        // Update tracked purchases after successful sell
        if (totalSoldTokens > 0 && totalBoughtTokens > 0) {
            const sellPercentage = totalSoldTokens / totalBoughtTokens;

            if (sellPercentage >= 0.99) {
                // Sold essentially all tracked tokens - clear tracking
                await UserActivity.updateMany(
                    {
                        asset: sellAsset,
                        conditionId: trade.conditionId,
                        side: 'BUY',
                        bot: true,
                        myBoughtSize: { $exists: true, $gt: 0 },
                    },
                    { $set: { myBoughtSize: 0 } }
                );
                Logger.info(
                    `🧹 已清除购买追踪记录 (卖出持仓的 ${(sellPercentage * 100).toFixed(1)}%)`
                );
            } else {
                // Partial sell - reduce tracked purchases proportionally
                for (const buy of previousBuys) {
                    const newSize = (buy.myBoughtSize || 0) * (1 - sellPercentage);
                    await UserActivity.updateOne(
                        { _id: buy._id },
                        { $set: { myBoughtSize: newSize } }
                    );
                }
                Logger.info(
                    `📝 已更新购买追踪记录 (卖出追踪持仓的 ${(sellPercentage * 100).toFixed(1)}%)`
                );
            }
        }

        if (abortDueToFunds) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: RETRY_LIMIT }
            );
            return 0;
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
        return totalSoldUsdc;
    } else {
        Logger.error(`未知条件: ${condition}`);
    }

    return 0;
};

/**
 * Market-sell up to `maxTokenAmount` of `tokenId` via FOK (no Mongo activity updates).
 * Used by position reconciliation / emergency flattening.
 */
export const marketSellTokensFOK = async (
    clobClient: ClobClient,
    tokenId: string,
    maxTokenAmount: number
): Promise<{ proceedsUsd: number; soldTokens: number }> => {
    let remaining = maxTokenAmount;
    let proceedsUsd = 0;
    let soldTokens = 0;
    let retry = 0;

    while (remaining >= MIN_ORDER_SIZE_TOKENS && retry < RETRY_LIMIT) {
        let orderBook;
        try {
            orderBook = await fetchOrderBookCached(clobClient, tokenId);
        } catch (orderBookError: unknown) {
            retry += 1;
            Logger.warning(
                `[marketSell] 订单簿查询失败 (${retry}/${RETRY_LIMIT}): ${orderBookError}`
            );
            continue;
        }

        if (!orderBook) {
            Logger.warning(`[marketSell] 无订单簿 (404/空): token ${tokenId.slice(0, 12)}...`);
            break;
        }

        if (!orderBook.bids || orderBook.bids.length === 0) {
            Logger.warning('[marketSell] 订单簿中无买方报价');
            break;
        }

        const bids = orderBook.bids as OrderBookEntry[];
        const maxPriceBid = bids.reduce(
            (max: OrderBookEntry, bid: OrderBookEntry) =>
                parseFloat(bid.price) > parseFloat(max.price) ? bid : max,
            bids[0]
        );

        const sellAmount = Math.min(remaining, parseFloat(maxPriceBid.size));
        if (sellAmount < MIN_ORDER_SIZE_TOKENS) {
            break;
        }

        const order_arges = {
            side: Side.SELL,
            tokenID: tokenId,
            amount: sellAmount,
            price: parseFloat(maxPriceBid.price),
        };

        const signedOrder = await clobClient.createMarketOrder(order_arges);
        const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
        if (resp.success === true) {
            retry = 0;
            soldTokens += order_arges.amount;
            proceedsUsd += order_arges.amount * order_arges.price;
            remaining -= order_arges.amount;
        } else {
            const errorMessage = extractOrderError(resp);
            if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                Logger.warning(
                    `[marketSell] 订单被拒绝: ${errorMessage || '余额或授权不足'}`
                );
                break;
            }
            retry += 1;
            Logger.warning(
                `[marketSell] 订单失败 (${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
            );
        }
    }

    return { proceedsUsd, soldTokens };
};

export default postOrder;
