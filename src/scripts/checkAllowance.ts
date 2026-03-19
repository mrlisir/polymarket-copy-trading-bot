import { ethers } from 'ethers';
import { AssetType, ClobClient, getContractConfig } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { ENV } from '../config/env';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const RPC_URL = ENV.RPC_URL;
const USDC_CONTRACT_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;
const POLYGON_CHAIN_ID = 137;
const POLYMARKET_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const POLYMARKET_EXCHANGE_LOWER = POLYMARKET_EXCHANGE.toLowerCase();
const POLYMARKET_COLLATERAL = getContractConfig(POLYGON_CHAIN_ID).collateral;
const POLYMARKET_COLLATERAL_LOWER = POLYMARKET_COLLATERAL.toLowerCase();
const NATIVE_USDC_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const NATIVE_USDC_LOWER = NATIVE_USDC_ADDRESS.toLowerCase();

// USDC ABI (only the functions we need)
const USDC_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)',
];

const buildClobClient = async (provider: ethers.providers.JsonRpcProvider): Promise<ClobClient> => {
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const code = await provider.getCode(PROXY_WALLET);
    const isProxySafe = code !== '0x';
    const signatureType = isProxySafe ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    console.log = function () {};
    console.error = function () {};

    const initialClient = new ClobClient(
        CLOB_HTTP_URL,
        POLYGON_CHAIN_ID,
        wallet,
        undefined,
        signatureType,
        isProxySafe ? PROXY_WALLET : undefined
    );

    let creds;
    let createWarning: string | undefined;
    let deriveWarning: string | undefined;
    try {
        try {
            creds = await initialClient.createApiKey();
        } catch (createError: any) {
            const msg = createError?.response?.data?.error || createError?.message;
            createWarning = `⚠️  Unable to create new API key${msg ? `: ${msg}` : ''}`;
        }

        if (!creds?.key) {
            try {
                creds = await initialClient.deriveApiKey();
            } catch (deriveError: any) {
                const msg = deriveError?.response?.data?.error || deriveError?.message;
                deriveWarning = `⚠️  Unable to derive API key${msg ? `: ${msg}` : ''}`;
            }
        }
    } finally {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
    }

    if (createWarning) {
        console.log(createWarning);
    }
    if (deriveWarning) {
        console.log(deriveWarning);
    }

    if (!creds?.key) {
        throw new Error('Failed to obtain Polymarket API credentials');
    }

    return new ClobClient(
        CLOB_HTTP_URL,
        POLYGON_CHAIN_ID,
        wallet,
        creds,
        signatureType,
        isProxySafe ? PROXY_WALLET : undefined
    );
};

const formatClobAmount = (raw: string, decimals: number): string => {
    try {
        return ethers.utils.formatUnits(raw, decimals);
    } catch {
        const numeric = parseFloat(raw);
        if (!Number.isFinite(numeric)) {
            return raw;
        }
        return numeric.toFixed(Math.min(decimals, 6));
    }
};

const syncPolymarketAllowanceCache = async (
    decimals: number,
    provider: ethers.providers.JsonRpcProvider
) => {
    try {
        console.log('🔄 Syncing Polymarket allowance cache...');
        const clobClient = await buildClobClient(provider);
        const updateParams = {
            asset_type: AssetType.COLLATERAL,
        } as const;

        const updateResult: any = await clobClient.updateBalanceAllowance(updateParams);
        if (updateResult && typeof updateResult === 'object' && 'error' in updateResult) {
            console.log('⚠️  Polymarket 缓存更新失败: ' + updateResult.error);
            return;
        }
        if (updateResult === '' || updateResult === null || updateResult === undefined) {
            console.log('ℹ  Polymarket 缓存更新已确认 (空响应)');
        } else if (typeof updateResult !== 'object') {
            console.log(
                '⚠️  Polymarket cache update returned an unexpected response:',
                JSON.stringify(updateResult)
            );
        } else {
            console.log('ℹ  Polymarket 缓存更新响应:', JSON.stringify(updateResult));
        }

        const balanceResponse: any = await clobClient.getBalanceAllowance(updateParams);
        if (!balanceResponse || typeof balanceResponse !== 'object') {
            console.log(
                '⚠️  Unexpected response from Polymarket when fetching balance/allowance:',
                JSON.stringify(balanceResponse)
            );
            return;
        }

        if ('error' in balanceResponse) {
            console.log(
                `⚠️  Unable to fetch Polymarket balance/allowance: ${balanceResponse.error}`
            );
            return;
        }

        const { balance, allowance } = balanceResponse as {
            balance?: string;
            allowance?: string;
            allowances?: Record<string, string>;
        };
        let allowanceValue: string | undefined = allowance;
        if (!allowanceValue && balanceResponse.allowances) {
            for (const [address, value] of Object.entries(balanceResponse.allowances)) {
                if (
                    address.toLowerCase() === POLYMARKET_EXCHANGE_LOWER &&
                    typeof value === 'string'
                ) {
                    allowanceValue = value;
                    break;
                }
            }
        }

        if (balance === undefined || allowanceValue === undefined) {
            console.log(
                '⚠️  Polymarket did not provide balance/allowance data. Raw response:',
                JSON.stringify(balanceResponse)
            );
            return;
        }

        const syncedBalance = formatClobAmount(balance, decimals);
        const syncedAllowance = formatClobAmount(allowanceValue, decimals);
        console.log(`💾 Polymarket 记录余额: ${syncedBalance} USDC`);
        console.log(`💾 Polymarket 记录授权额度: ${syncedAllowance} USDC\n`);
    } catch (syncError: any) {
        console.log(`⚠️  无法同步 Polymarket 缓存: ${syncError?.message || syncError}`);
    }
};

async function checkAndSetAllowance() {
    console.log('🔍 正在检查 USDC 余额和授权额度...\n');

    // Connect to Polygon
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    // Create USDC contract instance
    const usdcContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, wallet);

    try {
        // Get USDC decimals
        const decimals = await usdcContract.decimals();
        console.log(`💵 USDC 精度位数: ${decimals}`);

        const usesPolymarketCollateral =
            USDC_CONTRACT_ADDRESS.toLowerCase() === POLYMARKET_COLLATERAL_LOWER;

        // Local token balance & allowance (whatever is configured in .env)
        const localBalance = await usdcContract.balanceOf(PROXY_WALLET);
        const localAllowance = await usdcContract.allowance(PROXY_WALLET, POLYMARKET_EXCHANGE);
        const localBalanceFormatted = ethers.utils.formatUnits(localBalance, decimals);
        const localAllowanceFormatted = ethers.utils.formatUnits(localAllowance, decimals);

        console.log(
            `💰 Your USDC Balance (${USDC_CONTRACT_ADDRESS}): ${localBalanceFormatted} USDC`
        );
        console.log(
            `✅ Current Allowance (${USDC_CONTRACT_ADDRESS}): ${localAllowanceFormatted} USDC`
        );
        console.log(`📍 Polymarket 交易所: ${POLYMARKET_EXCHANGE}\n`);

        if (USDC_CONTRACT_ADDRESS.toLowerCase() !== NATIVE_USDC_LOWER) {
            try {
                const nativeContract = new ethers.Contract(NATIVE_USDC_ADDRESS, USDC_ABI, wallet);
                const nativeDecimals = await nativeContract.decimals();
                const nativeBalance = await nativeContract.balanceOf(PROXY_WALLET);
                if (!nativeBalance.isZero()) {
                    const nativeFormatted = ethers.utils.formatUnits(nativeBalance, nativeDecimals);
                    console.log('ℹ️  检测到原生 USDC (Polygon PoS) 余额:');
                    console.log(`    ${nativeFormatted} tokens at ${NATIVE_USDC_ADDRESS}`);
                console.log(
                    '    Polymarket 不识别此代币，请兑换为 USDC.e (0x2791...) 后交易。\n'
                );
                }
            } catch (nativeError) {
                console.log(`⚠️  无法检查原生 USDC 余额: ${nativeError}`);
            }
        }

        // Determine the contract Polymarket actually reads from (USDC.e)
        const polymarketContract = usesPolymarketCollateral
            ? usdcContract
            : new ethers.Contract(POLYMARKET_COLLATERAL, USDC_ABI, wallet);
        const polymarketDecimals = usesPolymarketCollateral
            ? decimals
            : await polymarketContract.decimals();
        const polymarketBalance = usesPolymarketCollateral
            ? localBalance
            : await polymarketContract.balanceOf(PROXY_WALLET);
        const polymarketAllowance = usesPolymarketCollateral
            ? localAllowance
            : await polymarketContract.allowance(PROXY_WALLET, POLYMARKET_EXCHANGE);

        if (!usesPolymarketCollateral) {
            const polymarketBalanceFormatted = ethers.utils.formatUnits(
                polymarketBalance,
                polymarketDecimals
            );
            const polymarketAllowanceFormatted = ethers.utils.formatUnits(
                polymarketAllowance,
                polymarketDecimals
            );
            console.log('⚠️  Polymarket 抵押品代币是 USDC.e (跨链桥接的)，地址如下');
            console.log(`    ${POLYMARKET_COLLATERAL}`);
            console.log(`⚠️  Polymarket 记录的 USDC 余额: ${polymarketBalanceFormatted} USDC`);
            console.log(`⚠️  Polymarket 记录的授权额度: ${polymarketAllowanceFormatted} USDC\n`);
            console.log(
                '👉  请将原生 USDC 兑换为 USDC.e 或更新 .env 文件指向抵押品代币后再交易。\n'
            );
        }

        if (polymarketAllowance.lt(polymarketBalance) || polymarketAllowance.isZero()) {
            console.log('⚠️  授权额度不足或为零！');
            console.log('📝 正在为 Polymarket 设置无限授权额度...\n');

            const maxAllowance = ethers.constants.MaxUint256;

            const feeData = await provider.getFeeData();
            const gasPrice = feeData.gasPrice
                ? feeData.gasPrice.mul(150).div(100)
                : ethers.utils.parseUnits('50', 'gwei');

            console.log(`⛽ Gas 价格: ${ethers.utils.formatUnits(gasPrice, 'gwei')} Gwei`);

            const approveTx = await polymarketContract.approve(POLYMARKET_EXCHANGE, maxAllowance, {
                gasPrice: gasPrice,
                gasLimit: 100000,
            });

            console.log(`⏳ 交易已发送: ${approveTx.hash}`);
            console.log('⏳ 等待确认...\n');

            const receipt = await approveTx.wait();

            if (receipt.status === 1) {
                console.log('✅ 授权额度设置成功！');
                console.log(`🔗 交易链接: https://polygonscan.com/tx/${approveTx.hash}\n`);

                const newAllowance = await polymarketContract.allowance(
                    PROXY_WALLET,
                    POLYMARKET_EXCHANGE
                );
                const newAllowanceFormatted = ethers.utils.formatUnits(
                    newAllowance,
                    polymarketDecimals
                );
                console.log(`✅ 新授权额度: ${newAllowanceFormatted} USDC`);
            } else {
                console.log('❌ 交易失败！');
            }
        } else {
            console.log('✅ 授权额度已充足！无需操作。');
        }

        await syncPolymarketAllowanceCache(polymarketDecimals, provider);
    } catch (error: any) {
        console.error('❌ 错误:', error.message);
        if (error.code === 'INSUFFICIENT_FUNDS') {
            console.log('\n⚠️  您需要 MATIC 来支付 Polygon 上的 Gas 费！');
        }
    }
}

checkAndSetAllowance()
    .then(() => {
        console.log('\n✅ 完成！');
        process.exit(0);
    })
    .catch((error) => {
        console.error('❌ 致命错误:', error);
        process.exit(1);
    });
