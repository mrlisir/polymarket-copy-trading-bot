import { ethers } from 'ethers';
import { AssetType, ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { ENV } from '../config/env';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;
const RPC_URL = ENV.RPC_URL;
const POLYGON_CHAIN_ID = 137;
const RETRY_LIMIT = ENV.RETRY_LIMIT;

// Market search query
const MARKET_SEARCH_QUERY = 'Maduro out in 2025';
const SELL_PERCENTAGE = 0.7; // 70%

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    title: string;
    outcome: string;
}

const isGnosisSafe = async (
    address: string,
    provider: ethers.providers.JsonRpcProvider
): Promise<boolean> => {
    try {
        const code = await provider.getCode(address);
        return code !== '0x';
    } catch (error) {
        console.error(`检查钱包类型时出错: ${error}`);
        return false;
    }
};

const createClobClient = async (
    provider: ethers.providers.JsonRpcProvider
): Promise<ClobClient> => {
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const isProxySafe = await isGnosisSafe(PROXY_WALLET, provider);
    const signatureType = isProxySafe ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;

    console.log(`钱包类型: ${isProxySafe ? 'Gnosis Safe 多签钱包' : 'EOA 普通钱包'}`);

    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    console.log = function () {};
    console.error = function () {};

    let clobClient = new ClobClient(
        CLOB_HTTP_URL,
        POLYGON_CHAIN_ID,
        wallet,
        undefined,
        signatureType,
        isProxySafe ? PROXY_WALLET : undefined
    );

    let creds = await clobClient.createApiKey();
    if (!creds.key) {
        creds = await clobClient.deriveApiKey();
    }

    clobClient = new ClobClient(
        CLOB_HTTP_URL,
        POLYGON_CHAIN_ID,
        wallet,
        creds,
        signatureType,
        isProxySafe ? PROXY_WALLET : undefined
    );

    console.log = originalConsoleLog;
    console.error = originalConsoleError;

    return clobClient;
};

const fetchPositions = async (): Promise<Position[]> => {
    const url = `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`获取持仓失败: ${response.statusText}`);
    }
    return response.json();
};

const findMatchingPosition = (positions: Position[], searchQuery: string): Position | undefined => {
    return positions.find((pos) => pos.title.toLowerCase().includes(searchQuery.toLowerCase()));
};

const updatePolymarketCache = async (clobClient: ClobClient, tokenId: string) => {
    try {
        console.log('🔄 正在更新 Polymarket 余额缓存...');
        const updateParams = {
            asset_type: AssetType.CONDITIONAL,
            token_id: tokenId,
        };

        await clobClient.updateBalanceAllowance(updateParams);
        console.log('✅ 缓存更新成功\n');
    } catch (error) {
        console.log('⚠️  警告: 无法更新缓存:', error);
    }
};

const sellPosition = async (clobClient: ClobClient, position: Position, sellSize: number) => {
    let remaining = sellSize;
    let retry = 0;

    console.log(
        `\n🔄 开始出售 ${sellSize.toFixed(2)} 个代币 (占仓位的 ${(SELL_PERCENTAGE * 100).toFixed(0)}%)`
    );
    console.log(`代币 ID: ${position.asset}`);
    console.log(`市场: ${position.title} - ${position.outcome}\n`);

    // Update Polymarket cache before selling
    await updatePolymarketCache(clobClient, position.asset);

    while (remaining > 0 && retry < RETRY_LIMIT) {
        try {
            // Get current order book
            const orderBook = await clobClient.getOrderBook(position.asset);

            if (!orderBook.bids || orderBook.bids.length === 0) {
                console.log('❌ 订单簿中无买方报价');
                break;
            }

            // Find best bid
            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            console.log(`📊 最优买价: ${maxPriceBid.size} 个代币 @ $${maxPriceBid.price}`);

            // Determine order size
            let orderAmount: number;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                orderAmount = remaining;
            } else {
                orderAmount = parseFloat(maxPriceBid.size);
            }

            // Create sell order
            const orderArgs = {
                side: Side.SELL,
                tokenID: position.asset,
                amount: orderAmount,
                price: parseFloat(maxPriceBid.price),
            };

            console.log(`📤 正在出售 ${orderAmount.toFixed(2)} 个代币 @ $${orderArgs.price}...`);

            const signedOrder = await clobClient.createMarketOrder(orderArgs);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success === true) {
                retry = 0;
                const soldValue = (orderAmount * orderArgs.price).toFixed(2);
                console.log(
                    `✅ 成功: 以 $${orderArgs.price} 出售 ${orderAmount.toFixed(2)} 个代币 (总计: $${soldValue})`
                );
                remaining -= orderAmount;

                if (remaining > 0) {
                    console.log(`⏳ 剩余待出售: ${remaining.toFixed(2)} 个代币\n`);
                }
            } else {
                retry += 1;
                const errorMsg = extractOrderError(resp);
                console.log(
                    `⚠️  订单失败 (第 ${retry}/${RETRY_LIMIT} 次)${errorMsg ? `: ${errorMsg}` : ''}`
                );

                if (retry < RETRY_LIMIT) {
                    console.log('🔄 重试中...\n');
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }
        } catch (error) {
            retry += 1;
            console.error(`❌ 出售第 ${retry}/${RETRY_LIMIT} 次时出错:`, error);

            if (retry < RETRY_LIMIT) {
                console.log('🔄 重试中...\n');
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
    }

    if (remaining > 0) {
        console.log(`\n⚠️  无法出售全部代币。剩余: ${remaining.toFixed(2)} 个代币`);
    } else {
        console.log(`\n🎉 成功出售 ${sellSize.toFixed(2)} 个代币！`);
    }
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

async function main() {
    console.log('🚀 手动出售脚本');
    console.log('═══════════════════════════════════════════════\n');
    console.log(`📍 钱包: ${PROXY_WALLET}`);
    console.log(`🔍 搜索市场: "${MARKET_SEARCH_QUERY}"`);
    console.log(`📊 出售比例: ${(SELL_PERCENTAGE * 100).toFixed(0)}%\n`);

    try {
        // Create provider and client
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        const clobClient = await createClobClient(provider);

        console.log('✅ 已连接到 Polymarket\n');

        // Get all positions
        console.log('📥 正在获取持仓...');
        const positions = await fetchPositions();
        console.log(`找到 ${positions.length} 个持仓\n`);

        // Find matching position
        const position = findMatchingPosition(positions, MARKET_SEARCH_QUERY);

        if (!position) {
            console.log(`❌ 未找到仓位 "${MARKET_SEARCH_QUERY}"！`);
            console.log('\n可用的持仓:');
            positions.forEach((pos, idx) => {
                console.log(
                    `${idx + 1}. ${pos.title} - ${pos.outcome} (${pos.size.toFixed(2)} 个代币)`
                );
            });
            process.exit(1);
        }

        console.log('✅ 已找到仓位！');
        console.log(`📌 市场: ${position.title}`);
        console.log(`📌 结果: ${position.outcome}`);
        console.log(`📌 持仓数量: ${position.size.toFixed(2)} 个代币`);
        console.log(`📌 平均价格: $${position.avgPrice.toFixed(4)}`);
        console.log(`📌 当前价值: $${position.currentValue.toFixed(2)}`);

        // Calculate sell size
        const sellSize = position.size * SELL_PERCENTAGE;

        if (sellSize < 1.0) {
            console.log(
                `\n❌ 出售数量 (${sellSize.toFixed(2)} 个代币) 低于最低限制 (1.0 个代币)`
            );
            console.log('请增加持仓或调整 SELL_PERCENTAGE');
            process.exit(1);
        }

        // Sell position
        await sellPosition(clobClient, position, sellSize);

        console.log('\n✅ 脚本执行完成！');
    } catch (error) {
        console.error('\n❌ 致命错误:', error);
        process.exit(1);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ 未处理的错误:', error);
        process.exit(1);
    });
