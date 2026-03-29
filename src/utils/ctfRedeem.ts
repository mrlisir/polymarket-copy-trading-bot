import { ethers } from 'ethers';
import { ENV } from '../config/env';
import Logger from './logger';

const CTF_CONTRACT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
];
const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];

/**
 * 赎回交易由 PRIVATE_KEY 对应地址支付 Polygon gas（MATIC），与 PROXY_WALLET / USDC 余额无关。
 * 在批量赎回前调用可避免连续 INSUFFICIENT_FUNDS 刷屏。
 */
export const assertPolygonGasForRedeem = async (): Promise<boolean> => {
    const provider = new ethers.providers.JsonRpcProvider(ENV.RPC_URL);
    const wallet = new ethers.Wallet(ENV.PRIVATE_KEY, provider);
    const bal = await provider.getBalance(wallet.address);
    const human = ethers.utils.formatEther(bal);
    const proxy = (ENV.PROXY_WALLET || '').trim();
    const proxyHint =
        proxy && wallet.address.toLowerCase() !== proxy.toLowerCase()
            ? ` PROXY_WALLET（${proxy.slice(0, 8)}…）为 Polymarket 交易/持仓地址，链上 redeem 的 gas 仍由 PRIVATE_KEY 地址 ${wallet.address} 支付。`
            : '';
    if (bal.isZero()) {
        Logger.warning(
            `[赎回] 无法发交易：签名地址 MATIC=0（${wallet.address}）。请向该地址转入 Polygon MATIC 作为 gas；与 USDC 多少无关。${proxyHint}`
        );
        return false;
    }
    const softMin = ethers.utils.parseEther('0.05');
    if (bal.lt(softMin)) {
        Logger.warning(
            `[赎回] 签名地址 MATIC 仅 ${human}，单笔 redeem 在网络拥堵时可能仍报 gas 不足；建议保持 ≥0.1 MATIC。${proxyHint}`
        );
    }
    return true;
};

/**
 * On-chain redeem for a Polymarket condition (same pattern as npm run redeem-resolved).
 * Resolves winning/losing outcome tokens into USDC after market settlement.
 */
export const redeemPolymarketCondition = async (conditionId: string): Promise<boolean> => {
    try {
        const provider = new ethers.providers.JsonRpcProvider(ENV.RPC_URL);
        const wallet = new ethers.Wallet(ENV.PRIVATE_KEY, provider);
        const maticBal = await provider.getBalance(wallet.address);
        if (maticBal.isZero()) {
            Logger.warning(
                `[赎回] 跳过 condition ${conditionId.slice(0, 12)}…：签名地址 ${wallet.address} MATIC=0，无法付 gas。`
            );
            return false;
        }
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
