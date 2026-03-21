import { ethers } from 'ethers';
import { ENV } from '../config/env';
import Logger from './logger';

const CTF_CONTRACT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
];
const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];

/**
 * On-chain redeem for a Polymarket condition (same pattern as npm run redeem-resolved).
 * Resolves winning/losing outcome tokens into USDC after market settlement.
 */
export const redeemPolymarketCondition = async (conditionId: string): Promise<boolean> => {
    try {
        const provider = new ethers.providers.JsonRpcProvider(ENV.RPC_URL);
        const wallet = new ethers.Wallet(ENV.PRIVATE_KEY, provider);
        const ctfContract = new ethers.Contract(CTF_CONTRACT_ADDRESS, CTF_ABI, wallet);
        const usdcContract = new ethers.Contract(ENV.USDC_CONTRACT_ADDRESS, ERC20_ABI, provider);

        const conditionIdBytes32 = ethers.utils.hexZeroPad(
            ethers.BigNumber.from(conditionId).toHexString(),
            32
        );
        const parentCollectionId = ethers.constants.HashZero;
        const indexSets = [1, 2];

        const feeData = await ctfContract.provider.getFeeData();
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
        if (!gasPrice) {
            throw new Error('无法确定 Gas 价格');
        }
        const adjustedGasPrice = gasPrice.mul(120).div(100);

        let balanceBefore: ethers.BigNumber | undefined;
        try {
            balanceBefore = await usdcContract.balanceOf(wallet.address);
        } catch (e) {
            Logger.warning(
                `[赎回] 读取赎回前 USDC 余额失败: ${e instanceof Error ? e.message : String(e)}`
            );
        }

        const tx = await ctfContract.redeemPositions(
            ENV.USDC_CONTRACT_ADDRESS,
            parentCollectionId,
            conditionIdBytes32,
            indexSets,
            {
                gasLimit: 500000,
                gasPrice: adjustedGasPrice,
            }
        );

        Logger.info(`[赎回] 已提交链上赎回: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            Logger.success(`[赎回] 条件 ${conditionId.slice(0, 12)}... 赎回成功`);
            try {
                const balanceAfter = await usdcContract.balanceOf(wallet.address);
                if (balanceBefore) {
                    const delta = balanceAfter.sub(balanceBefore);
                    const beforeFmt = Number(ethers.utils.formatUnits(balanceBefore, 6));
                    const afterFmt = Number(ethers.utils.formatUnits(balanceAfter, 6));
                    const deltaFmt = Number(ethers.utils.formatUnits(delta, 6));
                    Logger.info(
                        `[赎回] USDC 余额变化: $${beforeFmt.toFixed(2)} -> $${afterFmt.toFixed(2)} (回收 +$${deltaFmt.toFixed(2)})`
                    );
                } else {
                    const afterFmt = Number(ethers.utils.formatUnits(balanceAfter, 6));
                    Logger.info(`[赎回] 当前 USDC 余额: $${afterFmt.toFixed(2)}`);
                }
            } catch (e) {
                Logger.warning(
                    `[赎回] 读取赎回后 USDC 余额失败: ${e instanceof Error ? e.message : String(e)}`
                );
            }
            return true;
        }
        Logger.warning('[赎回] 交易回滚');
        return false;
    } catch (e) {
        Logger.warning(`[赎回] 失败: ${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
};
