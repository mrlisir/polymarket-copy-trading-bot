import { ethers } from 'ethers';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const RPC_URL = ENV.RPC_URL || 'https://polygon-rpc.com';

// Contract addresses on Polygon
const CTF_CONTRACT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC on Polygon

// Thresholds for considering a position "resolved"
const RESOLVED_HIGH = 0.99; // Position won (price ~$1)
const RESOLVED_LOW = 0.01; // Position lost (price ~$0)
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

// CTF Contract ABI (only the functions we need)
const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
    'function balanceOf(address owner, uint256 tokenId) external view returns (uint256)',
];

const loadPositions = async (address: string): Promise<Position[]> => {
    const url = `https://data-api.polymarket.com/positions?user=${address}`;
    const data = await fetchData(url);
    const positions = Array.isArray(data) ? (data as Position[]) : [];
    return positions.filter((pos) => (pos.size || 0) > ZERO_THRESHOLD);
};

const redeemPosition = async (
    ctfContract: ethers.Contract,
    position: Position
): Promise<{ success: boolean; error?: string }> => {
    try {
        // Convert conditionId to bytes32 format
        const conditionIdBytes32 = ethers.utils.hexZeroPad(
            ethers.BigNumber.from(position.conditionId).toHexString(),
            32
        );

        // parentCollectionId is always zero for Polymarket
        const parentCollectionId = ethers.constants.HashZero;

        // indexSets: [1, 2] represents both outcome collections
        // We use [1, 2] to redeem all positions for this condition
        const indexSets = [1, 2];

        console.log(`   正在尝试赎回...`);
        console.log(`   条件 ID: ${conditionIdBytes32}`);
        console.log(`   索引集: [${indexSets.join(', ')}]`);

        const feeData = await ctfContract.provider.getFeeData();
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;

        if (!gasPrice) {
            throw new Error('无法确定 Gas 价格');
        }

        const adjustedGasPrice = gasPrice.mul(120).div(100);

        console.log(`   Gas 价格: ${ethers.utils.formatUnits(adjustedGasPrice, 'gwei')} Gwei`);

        const tx = await ctfContract.redeemPositions(
            USDC_ADDRESS,
            parentCollectionId,
            conditionIdBytes32,
            indexSets,
            {
                gasLimit: 500000,
                gasPrice: adjustedGasPrice,
            }
        );

        console.log(`   ⏳ 交易已提交: ${tx.hash}`);
        console.log(`   ⏳ 等待确认...`);

        const receipt = await tx.wait();

        if (receipt.status === 1) {
            console.log(`   ✅ 赎回成功！使用的 Gas: ${receipt.gasUsed.toString()}`);
            return { success: true };
        } else {
            console.log(`   ❌ 交易失败`);
            return { success: false, error: '交易回滚' };
        }
    } catch (error: any) {
        const errorMessage = error.message || String(error);
        console.log(`   ❌ 赎回失败: ${errorMessage}`);
        return { success: false, error: errorMessage };
    }
};

const logPositionHeader = (position: Position, index: number, total: number) => {
    const status = position.curPrice >= RESOLVED_HIGH ? '🎉 赢' : '❌ 输';
    console.log(
        `\n${index + 1}/${total} ▶ ${status} | ${position.title || position.slug || position.asset}`
    );
    if (position.outcome) {
        console.log(`   结果: ${position.outcome}`);
    }
    console.log(`   持仓数量: ${position.size.toFixed(2)} 个代币`);
    console.log(`   当前价格: $${position.curPrice.toFixed(4)}`);
    console.log(`   预期价值: $${position.currentValue.toFixed(2)}`);
    console.log(`   可赎回: ${position.redeemable ? '是' : '否'}`);
};

const main = async () => {
    console.log('🚀 正在赎回已解决的仓位');
    console.log('════════════════════════════════════════════════════');
    console.log(`钱包: ${PROXY_WALLET}`);
    console.log(`CTF 合约: ${CTF_CONTRACT_ADDRESS}`);
    console.log(`盈利阈值: 价格 >= $${RESOLVED_HIGH}`);
    console.log(`亏损阈值: 价格 <= $${RESOLVED_LOW}`);

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    console.log(`\n✅ 已连接到 Polygon RPC`);
    console.log(`签名者地址: ${wallet.address}`);

    if (wallet.address.toLowerCase() !== PROXY_WALLET.toLowerCase()) {
        console.log(
            `⚠️  注意: 签名者 (${wallet.address}) 与代理钱包 (${PROXY_WALLET}) 不同`
        );
        console.log(`   请确保签名者有权限代表代理钱包执行交易`);
    }

    const ctfContract = new ethers.Contract(CTF_CONTRACT_ADDRESS, CTF_ABI, wallet);

    const allPositions = await loadPositions(PROXY_WALLET);

    if (allPositions.length === 0) {
        console.log('\n🎉 代理钱包未检测到任何开仓。');
        return;
    }

    const redeemablePositions = allPositions.filter(
        (pos) =>
            (pos.curPrice >= RESOLVED_HIGH || pos.curPrice <= RESOLVED_LOW) &&
            pos.redeemable === true
    );

    const activePositions = allPositions.filter(
        (pos) => pos.curPrice > RESOLVED_LOW && pos.curPrice < RESOLVED_HIGH
    );

    console.log(`\n📊 仓位统计:`);
    console.log(`   总仓位: ${allPositions.length}`);
    console.log(`   ✅ 已解决可赎回: ${redeemablePositions.length}`);
    console.log(`   ⏳ 活跃中 (无需处理): ${activePositions.length}`);

    if (redeemablePositions.length === 0) {
        console.log('\n✅ 没有需要赎回的仓位。');
        return;
    }

    console.log(`\n🔄 正在赎回 ${redeemablePositions.length} 个仓位...`);
    console.log(`⚠️  警告: 每次赎回都需要支付 Polygon 上的 Gas 费`);

    let successCount = 0;
    let failCount = 0;
    let totalValue = 0;

    const positionsByCondition = new Map<string, Position[]>();
    redeemablePositions.forEach((pos) => {
        const existing = positionsByCondition.get(pos.conditionId) || [];
        existing.push(pos);
        positionsByCondition.set(pos.conditionId, existing);
    });

    console.log(
        `\n📦 已分为 ${positionsByCondition.size} 个独立条件组`
    );

    let conditionIndex = 0;
    for (const [conditionId, positions] of positionsByCondition.entries()) {
        conditionIndex++;
        const totalPositionValue = positions.reduce((sum, pos) => sum + pos.currentValue, 0);

        console.log(`\n${'='.repeat(60)}`);
        console.log(`条件 ${conditionIndex}/${positionsByCondition.size}`);
        console.log(`条件 ID: ${conditionId}`);
        console.log(`此条件的仓位数量: ${positions.length}`);
        console.log(`预期总价值: $${totalPositionValue.toFixed(2)}`);

        positions.forEach((pos, idx) => {
            const status = pos.curPrice >= RESOLVED_HIGH ? '🎉' : '❌';
            console.log(
                `   ${status} ${pos.title || pos.slug} | ${pos.outcome} | ${pos.size.toFixed(2)} 个代币 | $${pos.currentValue.toFixed(2)}`
            );
        });

        const result = await redeemPosition(ctfContract, positions[0]);

        if (result.success) {
            successCount++;
            totalValue += totalPositionValue;
        } else {
            failCount++;
        }

        if (conditionIndex < positionsByCondition.size) {
            console.log(`   ⏳ 等待 2 秒后进行下一笔交易...`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }

    console.log('\n════════════════════════════════════════════════════');
    console.log('✅ 仓位赎回汇总');
    console.log(`已处理条件数: ${positionsByCondition.size}`);
    console.log(`成功赎回数: ${successCount}`);
    console.log(`失败数: ${failCount}`);
    console.log(`已赎回仓位的预期价值: $${totalValue.toFixed(2)}`);
    console.log('════════════════════════════════════════════════════\n');
};

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ 脚本因错误中止:', error);
        process.exit(1);
    });
