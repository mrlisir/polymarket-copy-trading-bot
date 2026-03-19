import { AssetType, ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import createClobClient from '../utils/createClobClient';
import fetchData from '../utils/fetchData';

const PROXY_WALLET = ENV.PROXY_WALLET;
const USER_ADDRESSES = ENV.USER_ADDRESSES;
const RETRY_LIMIT = ENV.RETRY_LIMIT;

// Polymarket enforces a 1 token minimum on sell orders
const MIN_SELL_TOKENS = 1.0;
const ZERO_THRESHOLD = 0.0001;

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

const updatePolymarketCache = async (clobClient: ClobClient, tokenId: string) => {
    try {
        await clobClient.updateBalanceAllowance({
            asset_type: AssetType.CONDITIONAL,
            token_id: tokenId,
        });
    } catch (error) {
        console.log(`⚠️  刷新 ${tokenId} 的余额缓存失败:`, error);
    }
};

const sellEntirePosition = async (
    clobClient: ClobClient,
    position: Position
): Promise<SellResult> => {
    let remaining = position.size;
    let attempts = 0;
    let soldTokens = 0;
    let proceedsUsd = 0;

    if (remaining < MIN_SELL_TOKENS) {
        console.log(
            `   ❌ Position size ${remaining.toFixed(4)} < ${MIN_SELL_TOKENS} token minimum, skipping`
        );
        return { soldTokens: 0, proceedsUsd: 0, remainingTokens: remaining };
    }

    await updatePolymarketCache(clobClient, position.asset);

    while (remaining >= MIN_SELL_TOKENS && attempts < RETRY_LIMIT) {
        const orderBook = await clobClient.getOrderBook(position.asset);

        if (!orderBook.bids || orderBook.bids.length === 0) {
            console.log('   ❌ 订单簿无买方报价 — 流动性不足');
            break;
        }

        const bestBid = orderBook.bids.reduce((max, bid) => {
            return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
        }, orderBook.bids[0]);

        const bidSize = parseFloat(bestBid.size);
        const bidPrice = parseFloat(bestBid.price);

        if (bidSize < MIN_SELL_TOKENS) {
            console.log(
                `   ❌ 最优买方报价仅 ${bidSize.toFixed(2)} 个代币 (< ${MIN_SELL_TOKENS})`
            );
            break;
        }

        const sellAmount = Math.min(remaining, bidSize);

        if (sellAmount < MIN_SELL_TOKENS) {
            console.log(`   ❌ 剩余数量 ${sellAmount.toFixed(4)} 低于最低出售数量`);
            break;
        }

        const orderArgs = {
            side: Side.SELL,
            tokenID: position.asset,
            amount: sellAmount,
            price: bidPrice,
        };

        try {
            const signedOrder = await clobClient.createMarketOrder(orderArgs);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success === true) {
                const tradeValue = sellAmount * bidPrice;
                soldTokens += sellAmount;
                proceedsUsd += tradeValue;
                remaining -= sellAmount;
                attempts = 0;
                console.log(
                    `   ✅ 成功卖出 ${sellAmount.toFixed(2)} 个代币 @ $${bidPrice.toFixed(3)} (≈ $${tradeValue.toFixed(2)})`
                );
            } else {
                attempts += 1;
                const errorMessage = extractOrderError(resp);

                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    console.log(
                        `   ❌ 订单被拒绝: ${errorMessage ?? '余额或授权问题'}`
                    );
                    break;
                }
                console.log(
                    `   ⚠️  出售第 ${attempts}/${RETRY_LIMIT} 次失败${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        } catch (error) {
            attempts += 1;
            console.log(`   ⚠️  出售第 ${attempts}/${RETRY_LIMIT} 次出错:`, error);
        }
    }

    if (remaining >= MIN_SELL_TOKENS) {
        console.log(`   ⚠️  剩余未出售: ${remaining.toFixed(2)} 个代币`);
    } else if (remaining > 0) {
        console.log(
            `   ℹ️  残余粉尘 < ${MIN_SELL_TOKENS} 个代币 (${remaining.toFixed(4)})`
        );
    }

    return { soldTokens, proceedsUsd, remainingTokens: remaining };
};

const loadPositions = async (address: string): Promise<Position[]> => {
    const url = `https://data-api.polymarket.com/positions?user=${address}`;
    const data = await fetchData(url);
    const positions = Array.isArray(data) ? (data as Position[]) : [];
    return positions.filter((pos) => (pos.size || 0) > ZERO_THRESHOLD);
};

const buildTrackedSet = async (): Promise<Set<string>> => {
    const tracked = new Set<string>();

    for (const user of USER_ADDRESSES) {
        try {
            const positions = await loadPositions(user);
            positions.forEach((pos) => {
                if ((pos.size || 0) > ZERO_THRESHOLD) {
                    tracked.add(`${pos.conditionId}:${pos.asset}`);
                }
            });
        } catch (error) {
            console.log(`⚠️  加载 ${user} 的持仓失败:`, error);
        }
    }

    return tracked;
};

const logPositionHeader = (position: Position, index: number, total: number) => {
    console.log(`\n${index + 1}/${total} ▶ ${position.title || position.slug || position.asset}`);
    if (position.outcome) {
        console.log(`   结果: ${position.outcome}`);
    }
    console.log(
        `   持仓: ${position.size.toFixed(2)} 个代币 @ 平均价格 $${position.avgPrice.toFixed(3)}`
    );
    console.log(
        `   估计价值: $${position.currentValue.toFixed(2)} (当前价格 $${position.curPrice.toFixed(3)})`
    );
    if (position.redeemable) {
        console.log('   ℹ️  市场可赎回 — 如果价值保持在 $0 可考虑赎回。');
    }
};

const main = async () => {
    console.log('🚀 正在平仓陈旧仓位 (跟踪的交易员已退出)');
    console.log('════════════════════════════════════════════════════');
    console.log(`钱包: ${PROXY_WALLET}`);

    const clobClient = await createClobClient();
    console.log('✅ 已连接到 Polymarket CLOB');

    const [myPositions, trackedPositions] = await Promise.all([
        loadPositions(PROXY_WALLET),
        buildTrackedSet(),
    ]);

    if (myPositions.length === 0) {
        console.log('\n🎉 代理钱包未检测到任何开仓。');
        return;
    }

    const stalePositions = myPositions.filter(
        (pos) => !trackedPositions.has(`${pos.conditionId}:${pos.asset}`)
    );

    if (stalePositions.length === 0) {
        console.log('\n✅ 所有仓位仍由跟踪的交易员持有。无需平仓。');
        return;
    }

    console.log(`\n发现 ${stalePositions.length} 个陈旧仓位待平仓。`);

    let totalTokens = 0;
    let totalProceeds = 0;

    for (let i = 0; i < stalePositions.length; i += 1) {
        const position = stalePositions[i];
        logPositionHeader(position, i, stalePositions.length);

        try {
            const result = await sellEntirePosition(clobClient, position);
            totalTokens += result.soldTokens;
            totalProceeds += result.proceedsUsd;
        } catch (error) {
            console.log('   ❌ 由于意外错误无法平仓:', error);
        }
    }

    console.log('\n════════════════════════════════════════════════════');
    console.log('✅ 平仓汇总');
    console.log(`涉及市场: ${stalePositions.length}`);
    console.log(`已出售代币: ${totalTokens.toFixed(2)}`);
    console.log(`已实现 USDC (约): $${totalProceeds.toFixed(2)}`);
    console.log('════════════════════════════════════════════════════\n');
};

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ 脚本因错误中止:', error);
        process.exit(1);
    });
