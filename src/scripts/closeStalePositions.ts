import { AssetType, ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import createClobClient from '../utils/createClobClient';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';

const PROXY_WALLET = ENV.PROXY_WALLET;
const USER_ADDRESSES = ENV.USER_ADDRESSES;
const RETRY_LIMIT = ENV.RETRY_LIMIT;

// Polymarket enforces a 1 token minimum on sell orders
const MIN_SELL_TOKENS = 1.0;
const ZERO_THRESHOLD = 0.0001;

export interface StalePosition {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    curPrice: number;
    title?: string;
    outcome?: string;
    slug?: string;
    redeemable?: boolean;
}

export interface StalePositionSellResult {
    position: StalePosition;
    soldTokens: number;
    proceedsUsd: number;
    remainingTokens: number;
}

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    curPrice: number;
    title?: string;
    outcome?: string;
    slug?: string;
    redeemable?: boolean;
}

interface SellResult {
    soldTokens: number;
    proceedsUsd: number;
    remainingTokens: number;
}

const extractOrderError = (response: unknown): string | undefined => {
    if (!response) return undefined;
    if (typeof response === 'string') return response;
    if (typeof response === 'object') {
        const data = response as Record<string, unknown>;
        const directError = data.error;
        if (typeof directError === 'string') return directError;
        if (typeof directError === 'object' && directError !== null) {
            const nested = directError as Record<string, unknown>;
            if (typeof nested.error === 'string') return nested.error;
            if (typeof nested.message === 'string') return nested.message;
        }
        if (typeof data.errorMsg === 'string') return data.errorMsg;
        if (typeof data.message === 'string') return data.message;
    }
    return undefined;
};

const isInsufficientBalanceOrAllowanceError = (message: string | undefined): boolean => {
    if (!message) return false;
    return message.toLowerCase().includes('not enough balance') || message.toLowerCase().includes('allowance');
};

const updatePolymarketCache = async (clobClient: ClobClient, tokenId: string) => {
    try {
        await clobClient.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId });
    } catch (error) {
        Logger.warning(`刷新 ${tokenId} 的余额缓存失败: ${error}`);
    }
};

const sellPosition = async (clobClient: ClobClient, position: StalePosition): Promise<SellResult> => {
    let remaining = position.size;
    let attempts = 0;
    let soldTokens = 0;
    let proceedsUsd = 0;

    if (remaining < MIN_SELL_TOKENS) {
        return { soldTokens: 0, proceedsUsd: 0, remainingTokens: remaining };
    }

    await updatePolymarketCache(clobClient, position.asset);

    while (remaining >= MIN_SELL_TOKENS && attempts < RETRY_LIMIT) {
        const orderBook = await clobClient.getOrderBook(position.asset);

        if (!orderBook.bids || orderBook.bids.length === 0) {
            Logger.warning('订单簿无买方报价 — 流动性不足');
            break;
        }

        const bestBid = orderBook.bids.reduce(
            (max, bid) => (parseFloat(bid.price) > parseFloat(max.price) ? bid : max),
            orderBook.bids[0]
        );

        const bidSize = parseFloat(bestBid.size);
        const bidPrice = parseFloat(bestBid.price);
        const sellAmount = Math.min(remaining, bidSize);

        if (sellAmount < MIN_SELL_TOKENS || bidSize < MIN_SELL_TOKENS) {
            break;
        }

        try {
            const signedOrder = await clobClient.createMarketOrder({
                side: Side.SELL,
                tokenID: position.asset,
                amount: sellAmount,
                price: bidPrice,
            });
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success === true) {
                const tradeValue = sellAmount * bidPrice;
                soldTokens += sellAmount;
                proceedsUsd += tradeValue;
                remaining -= sellAmount;
                attempts = 0;
                Logger.success(
                    `卖出 ${sellAmount.toFixed(2)} 代币 @ $${bidPrice.toFixed(3)} (≈ $${tradeValue.toFixed(2)})`
                );
            } else {
                attempts += 1;
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    Logger.error(`订单被拒绝: ${errorMessage ?? '余额或授权问题'}`);
                    break;
                }
                Logger.warning(
                    `卖出失败 (${attempts}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        } catch (error) {
            attempts += 1;
            Logger.warning(`卖出出错 (${attempts}/${RETRY_LIMIT}): ${error}`);
        }
    }

    if (remaining >= MIN_SELL_TOKENS) {
        Logger.warning(`剩余未出售: ${remaining.toFixed(2)} 代币`);
    }

    return { soldTokens, proceedsUsd, remainingTokens: remaining };
};

const loadPositions = async (address: string): Promise<Position[]> => {
    const data = await fetchData(`https://data-api.polymarket.com/positions?user=${address}`);
    return (Array.isArray(data) ? data : []) as Position[];
};

const buildTrackedSet = async (): Promise<Set<string>> => {
    const tracked = new Set<string>();
    for (const user of USER_ADDRESSES) {
        try {
            const positions = await loadPositions(user);
            for (const pos of positions) {
                if ((pos.size || 0) > ZERO_THRESHOLD) {
                    tracked.add(`${pos.conditionId}:${pos.asset}`);
                }
            }
        } catch (error) {
            Logger.warning(`加载交易员 ${user} 的持仓失败: ${error}`);
        }
    }
    return tracked;
};

/**
 * Find and optionally close positions that are held by the bot wallet
 * but no longer held by any of the tracked traders.
 *
 * @param clobClient - Optional pre-created CLOB client. If not provided, one will be created.
 * @param dryRun - If true, only identifies stale positions without selling them.
 * @returns Array of stale positions with their sell results (if not dryRun).
 */
export async function closeStalePositionsIfAny(
    clobClient?: ClobClient,
    dryRun = false
): Promise<{ positions: StalePosition[]; totalSold: number; totalProceeds: number }> {
    Logger.header('🔍 平仓检查 — 查找陈旧仓位');

    const [myPositions, trackedPositions] = await Promise.all([
        loadPositions(PROXY_WALLET),
        buildTrackedSet(),
    ]);

    const myActivePositions = myPositions.filter((pos) => (pos.size || 0) > ZERO_THRESHOLD);

    if (myActivePositions.length === 0) {
        Logger.success('代理钱包未检测到任何持仓');
        return { positions: [], totalSold: 0, totalProceeds: 0 };
    }

    const stalePositions = myActivePositions.filter(
        (pos) => !trackedPositions.has(`${pos.conditionId}:${pos.asset}`)
    );

    if (stalePositions.length === 0) {
        Logger.success(`所有 ${myActivePositions.length} 个仓位仍由跟踪的交易员持有，无需平仓`);
        return { positions: [], totalSold: 0, totalProceeds: 0 };
    }

    Logger.info(`发现 ${stalePositions.length} 个陈旧仓位 (跟踪的交易员均已不再持有)`);

    for (let i = 0; i < stalePositions.length; i++) {
        const pos = stalePositions[i];
        const title = pos.title || pos.slug || pos.asset;
        Logger.info(
            `[${i + 1}/${stalePositions.length}] ${title}${pos.outcome ? ` (${pos.outcome})` : ''}`
        );
        Logger.info(
            `  持仓: ${pos.size.toFixed(2)} 代币 | 均价: $${pos.avgPrice.toFixed(3)} | 价值: $${pos.currentValue.toFixed(2)}`
        );
        if (pos.redeemable) {
            Logger.info(`  市场已结算 — 可赎回`);
        }
    }

    if (dryRun) {
        Logger.warning('Dry-run 模式 — 仅识别仓位，不执行卖出');
        return { positions: stalePositions, totalSold: 0, totalProceeds: 0 };
    }

    const client = clobClient || (await createClobClient());
    let totalSold = 0;
    let totalProceeds = 0;

    for (let i = 0; i < stalePositions.length; i++) {
        const pos = stalePositions[i];
        const title = pos.title || pos.slug || pos.asset;
        Logger.info(`\n[${i + 1}/${stalePositions.length}] 正在平仓: ${title}`);
        try {
            const result = await sellPosition(client, pos);
            totalSold += result.soldTokens;
            totalProceeds += result.proceedsUsd;
        } catch (error) {
            Logger.error(`平仓失败: ${error}`);
        }
    }

    Logger.header('平仓汇总');
    Logger.info(`涉及市场: ${stalePositions.length}`);
    Logger.info(`已出售代币: ${totalSold.toFixed(2)}`);
    Logger.info(`已实现 USDC: $${totalProceeds.toFixed(2)}`);

    return { positions: stalePositions, totalSold, totalProceeds };
}

// CLI entry point
const main = async () => {
    await closeStalePositionsIfAny();
};

// Only run as CLI if executed directly (not when imported)
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((error) => {
            Logger.error(`脚本错误: ${error}`);
            process.exit(1);
        });
}
