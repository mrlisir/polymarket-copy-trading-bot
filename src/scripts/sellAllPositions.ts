import { ethers } from 'ethers';
import { AssetType, ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import { resolveSellScriptClobSignerMode } from '../utils/resolveSellScriptClobSignerMode';
import {
    capSellSizeByBalance,
    isInsufficientBalanceOrAllowanceMessage,
    syncConditionalBalanceShares,
} from '../utils/clobConditionalSellSync';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;
const RPC_URL = ENV.RPC_URL;
const POLYGON_CHAIN_ID = 137;
const RETRY_LIMIT = ENV.RETRY_LIMIT;

const createClobClientForSellScript = async (
    provider: ethers.providers.JsonRpcProvider
): Promise<ClobClient> => {
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const { signatureType, funderAddress, modeLabel } = await resolveSellScriptClobSignerMode(
        provider,
        PRIVATE_KEY,
        PROXY_WALLET
    );

    console.log(`CLOB signer mode: ${modeLabel}`);

    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;

    try {
        console.log = function () {};
        console.error = function () {};

        let clobClient = new ClobClient(
            CLOB_HTTP_URL,
            POLYGON_CHAIN_ID,
            wallet,
            undefined,
            signatureType,
            funderAddress
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
            funderAddress
        );

        return clobClient;
    } finally {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
    }
};

/** Polymarket minimum sell size (same as other sell scripts) */
const MIN_SELL_TOKENS = 1.0;

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    initialValue: number;
    currentValue: number;
    cashPnl: number;
    percentPnl: number;
    totalBought: number;
    realizedPnl: number;
    percentRealizedPnl: number;
    curPrice: number;
    title?: string;
    slug?: string;
    outcome?: string;
}

const argv = process.argv.slice(2);
const confirmed = argv.includes('--yes') || argv.includes('-y');

const updatePolymarketCache = async (clobClient: ClobClient, tokenId: string) => {
    try {
        console.log('🔄 Updating Polymarket balance cache for token...');
        const updateParams = {
            asset_type: AssetType.CONDITIONAL,
            token_id: tokenId,
        };

        await clobClient.updateBalanceAllowance(updateParams);
        console.log('✅ Cache updated successfully\n');
    } catch (error) {
        console.log('⚠️  Warning: Could not update cache:', error);
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

const sellPosition = async (clobClient: ClobClient, position: Position, sellSize: number) => {
    let retry = 0;

    console.log(`\n🔄 Starting to sell ${sellSize.toFixed(2)} tokens (100% of tracked size)`);
    console.log(`Token ID: ${position.asset.slice(0, 20)}...`);
    console.log(`Market: ${position.title} - ${position.outcome}\n`);

    await updatePolymarketCache(clobClient, position.asset);
    const synced = await syncConditionalBalanceShares(clobClient, position.asset);
    let remaining = capSellSizeByBalance(sellSize, synced?.balance);
    if (synced) {
        const alw =
            synced.allowanceFormatted !== undefined
                ? ` | CLOB allowance: ${synced.allowanceFormatted}`
                : '';
        console.log(
            `📎 CLOB conditional after sync: balance ${synced.balance.toFixed(6)} shares → sell up to ${remaining.toFixed(6)}${alw}\n`
        );
    } else {
        console.log(
            `📎 CLOB balance not fetched; rounding guard sell up to ${remaining.toFixed(6)} shares\n`
        );
    }
    if (remaining < sellSize - 1e-6) {
        console.log(`   (data-api reported ${sellSize.toFixed(6)} shares; using CLOB-capped amount)\n`);
    }
    if (remaining < 1.0) {
        console.log(
            `⚠️ Below 1 share minimum after cap. Fix CTF approvals: npm run set-token-allowance (Exchange + Neg-risk)\n`
        );
        return false;
    }

    while (remaining > 0 && retry < RETRY_LIMIT) {
        try {
            const orderBook = await clobClient.getOrderBook(position.asset);

            if (!orderBook.bids || orderBook.bids.length === 0) {
                console.log('❌ No bids available in order book');
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            console.log(`📊 Best bid: ${maxPriceBid.size} tokens @ $${maxPriceBid.price}`);

            let orderAmount: number;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                orderAmount = remaining;
            } else {
                orderAmount = parseFloat(maxPriceBid.size);
            }

            const orderArgs = {
                side: Side.SELL,
                tokenID: position.asset,
                amount: orderAmount,
                price: parseFloat(maxPriceBid.price),
            };

            console.log(`📤 Selling ${orderAmount.toFixed(2)} tokens at $${orderArgs.price}...`);

            const signedOrder = await clobClient.createMarketOrder(orderArgs);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success === true) {
                retry = 0;
                const soldValue = (orderAmount * orderArgs.price).toFixed(2);
                console.log(
                    `✅ SUCCESS: Sold ${orderAmount.toFixed(2)} tokens at $${orderArgs.price} (Total: $${soldValue})`
                );
                remaining -= orderAmount;

                if (remaining > 0) {
                    console.log(`⏳ Remaining to sell: ${remaining.toFixed(2)} tokens\n`);
                }
            } else {
                retry += 1;
                const errorMsg = extractOrderError(resp);
                console.log(
                    `⚠️  Order failed (attempt ${retry}/${RETRY_LIMIT})${errorMsg ? `: ${errorMsg}` : ''}`
                );

                if (isInsufficientBalanceOrAllowanceMessage(errorMsg)) {
                    console.log(
                        '💡 balance/allowance: run `npm run set-token-allowance` (CTF must approve standard + neg-risk exchange). Need MATIC.\n'
                    );
                    const again = await syncConditionalBalanceShares(clobClient, position.asset, 700);
                    const capped = capSellSizeByBalance(remaining, again?.balance);
                    if (capped < remaining - 1e-8) {
                        remaining = capped;
                        console.log(`📎 Re-synced; reduced remaining to ${remaining.toFixed(6)} shares\n`);
                        retry = 0;
                    }
                }

                if (retry < RETRY_LIMIT) {
                    console.log('🔄 Retrying...\n');
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }
        } catch (error) {
            retry += 1;
            console.error(`❌ Error during sell attempt ${retry}/${RETRY_LIMIT}:`, error);

            if (retry < RETRY_LIMIT) {
                console.log('🔄 Retrying...\n');
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
    }

    if (remaining > 0) {
        console.log(`\n⚠️  Could not sell all tokens. Remaining: ${remaining.toFixed(2)} tokens`);
        return false;
    }
    console.log(`\n🎉 Successfully sold ${sellSize.toFixed(2)} tokens!`);
    return true;
};

async function main() {
    console.log('🚀 Sell All Positions');
    console.log('═══════════════════════════════════════════════\n');
    console.log(`📍 Wallet: ${PROXY_WALLET}`);
    console.log(`📊 Mode: sell 100% of each position (min ${MIN_SELL_TOKENS} share per market)\n`);

    if (!confirmed) {
        console.log('⚠️  This will place real sell orders for every eligible position.');
        console.log('   To confirm, run:\n');
        console.log('   npm run sell-all -- --yes\n');
        process.exit(1);
    }

    try {
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        const clobClient = await createClobClientForSellScript(provider);

        console.log('✅ Connected to Polymarket\n');

        console.log('📥 Fetching positions...');
        const positions: Position[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
        );
        console.log(`Found ${positions.length} position(s)\n`);

        const toSell = positions
            .filter((p) => p.size >= MIN_SELL_TOKENS)
            .sort((a, b) => b.currentValue - a.currentValue);

        if (toSell.length === 0) {
            console.log(
                `✅ No positions with size ≥ ${MIN_SELL_TOKENS} share(s). Nothing to sell.`
            );
            process.exit(0);
        }

        console.log(`🎯 Will attempt full exit on ${toSell.length} position(s):\n`);
        for (const pos of toSell) {
            console.log(`  • ${pos.title || 'Unknown'} [${pos.outcome}]`);
            console.log(
                `    ~$${pos.currentValue.toFixed(2)} | ${pos.size.toFixed(2)} shares → sell all\n`
            );
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        let successCount = 0;
        let failureCount = 0;
        let totalSold = 0;

        for (let i = 0; i < toSell.length; i++) {
            const position = toSell[i];
            const sellSize = position.size;

            console.log(`\n📦 Position ${i + 1}/${toSell.length}`);
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`Market: ${position.title || 'Unknown'}`);
            console.log(`Outcome: ${position.outcome || 'Unknown'}`);
            console.log(`Position size: ${position.size.toFixed(2)} tokens`);
            console.log(`Average price: $${position.avgPrice.toFixed(4)}`);
            console.log(`Current value: $${position.currentValue.toFixed(2)}`);
            console.log(`PnL: $${position.cashPnl.toFixed(2)} (${position.percentPnl.toFixed(2)}%)`);

            const success = await sellPosition(clobClient, position, sellSize);

            if (success) {
                successCount++;
                totalSold += sellSize;
            } else {
                failureCount++;
            }

            if (i < toSell.length - 1) {
                console.log('\n⏳ Waiting 2 seconds before next sale...\n');
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
        }

        const skipped = positions.length - toSell.length;
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📊 SUMMARY');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`✅ Successful full exits: ${successCount}/${toSell.length}`);
        console.log(`❌ Incomplete / failed: ${failureCount}/${toSell.length}`);
        if (skipped > 0) {
            console.log(`⏭️  Skipped (< ${MIN_SELL_TOKENS} share): ${skipped}`);
        }
        console.log(`📦 Total shares targeted: ${totalSold.toFixed(2)}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        console.log('✅ Script completed!');
    } catch (error) {
        console.error('\n❌ Fatal error:', error);
        process.exit(1);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Unhandled error:', error);
        process.exit(1);
    });
