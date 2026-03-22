import { AssetType, ClobClient, CONDITIONAL_TOKEN_DECIMALS } from '@polymarket/clob-client';
import { ethers } from 'ethers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const isInsufficientBalanceOrAllowanceMessage = (msg: string | undefined): boolean => {
    if (!msg) {
        return false;
    }
    const lower = msg.toLowerCase();
    return lower.includes('not enough balance') || lower.includes('allowance');
};

/**
 * 刷新 CLOB 条件代币缓存并读取余额（6 位小数），用于卖出前与 data-api 仓位对齐、避免舍入超额。
 */
export async function syncConditionalBalanceShares(
    clobClient: ClobClient,
    tokenId: string,
    settleMs = 500
): Promise<{ balance: number; allowanceFormatted?: string } | null> {
    const params = { asset_type: AssetType.CONDITIONAL, token_id: tokenId } as const;
    await clobClient.updateBalanceAllowance(params);
    if (settleMs > 0) {
        await sleep(settleMs);
    }
    const raw = (await clobClient.getBalanceAllowance(params)) as unknown;
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const rec = raw as Record<string, unknown>;
    if ('error' in rec) {
        return null;
    }
    const bal = rec.balance;
    if (bal == null) {
        return null;
    }
    const balance = parseFloat(
        ethers.utils.formatUnits(String(bal), CONDITIONAL_TOKEN_DECIMALS)
    );
    let allowanceFormatted: string | undefined;
    if (rec.allowance != null) {
        try {
            allowanceFormatted = ethers.utils.formatUnits(
                String(rec.allowance),
                CONDITIONAL_TOKEN_DECIMALS
            );
        } catch {
            allowanceFormatted = String(rec.allowance);
        }
    }
    return { balance, allowanceFormatted };
}

/** 用 CLOB 报告的余额封顶卖出量，并向下取整到 6 位小数，避免 FOK 因微量超额失败 */
export function capSellSizeByBalance(requested: number, clobBalance?: number): number {
    if (clobBalance === undefined || !Number.isFinite(clobBalance)) {
        return Math.max(0, Math.floor(requested * 1e6 - 1) / 1e6);
    }
    const capped = Math.min(requested, Math.max(0, clobBalance - 1e-5));
    return Math.max(0, Math.floor(capped * 1e6) / 1e6);
}
