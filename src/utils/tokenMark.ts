import { ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import { fetchClobLightPriceUsdCached } from './clobPublicPrice';
import { fetchPositionsForUser } from './dataApiCache';
import { getGammaValuationUsdForAsset } from './gammaSettlement';
import { fetchOrderBookCached } from './postOrder';
import { getCurPriceForAsset, refreshCurPriceMap } from './positionValuation';

/** 已结算侧 curPrice≈0/1 时优先采用，避免无订单簿(404)时误用陈旧盘口 mid */
const SETTLED_TRUST_LOW = 0.01;
const SETTLED_TRUST_HIGH = 0.99;

/** 最优买价 = 最高 bid；最优卖价 = 最低 ask（不假设 API 已排序） */
export const computeOrderBookMid = (
    ob: { bids: { price: string }[]; asks: { price: string }[] } | null | undefined
): number | null => {
    if (!ob?.bids?.length || !ob.asks?.length) return null;
    let bestBid = -Infinity;
    for (const b of ob.bids) {
        const p = parseFloat(b.price);
        if (isFinite(p) && p > bestBid) bestBid = p;
    }
    let bestAsk = Infinity;
    for (const a of ob.asks) {
        const p = parseFloat(a.price);
        if (isFinite(p) && p < bestAsk) bestAsk = p;
    }
    if (!isFinite(bestBid) || !isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) return null;
    if (bestAsk < bestBid) return null;
    return (bestBid + bestAsk) / 2;
};

const parseRowCurPrice = (pos: Record<string, unknown>): number | null => {
    const v = pos.curPrice;
    if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
    if (typeof v === 'string') {
        const n = parseFloat(v);
        if (isFinite(n) && n >= 0) return n;
    }
    return null;
};

/**
 * 单 token 估值：Data curPrice → CLOB 轻量价(mid/last-trade) → Gamma 已收盘 outcome → 最后才拉整本 orderbook。
 */
export const resolveTokenMarkUsd = async (
    clobClient: ClobClient,
    tokenId: string,
    options?: { curPriceHint?: number; conditionId?: string }
): Promise<number> => {
    const divergence = ENV.MARK_CUR_VS_BOOK_DIVERGENCE;

    await refreshCurPriceMap(false);
    let cp = options?.curPriceHint;
    if (cp === undefined || !isFinite(cp) || cp < 0) {
        cp = await getCurPriceForAsset(tokenId, false);
    }
    if (cp === undefined || !isFinite(cp) || cp < 0) {
        await refreshCurPriceMap(true);
        cp = await getCurPriceForAsset(tokenId, true);
    }

    if (cp !== undefined && isFinite(cp) && cp >= 0 && cp <= 1) {
        if (cp <= SETTLED_TRUST_LOW || cp >= SETTLED_TRUST_HIGH) {
            return cp;
        }
    }

    const pickAgainstRef = (ref: number | null): number | null => {
        if (ref === null || !isFinite(ref) || ref < 0) return null;
        if (cp !== undefined && isFinite(cp) && cp >= 0) {
            if (Math.abs(cp - ref) > divergence) {
                return ref;
            }
            return cp;
        }
        return ref;
    };

    const lightPx = await fetchClobLightPriceUsdCached(tokenId);
    const fromLight = pickAgainstRef(lightPx !== null ? lightPx : null);
    if (fromLight !== null) {
        return fromLight;
    }

    const gammaPx = await getGammaValuationUsdForAsset(options?.conditionId, tokenId);
    if (gammaPx !== undefined && isFinite(gammaPx) && gammaPx >= 0) {
        return gammaPx;
    }

    const ob = await fetchOrderBookCached(clobClient, tokenId);
    const mid = ob ? computeOrderBookMid(ob) : null;
    const fromBook = pickAgainstRef(mid);
    if (fromBook !== null) {
        return fromBook;
    }
    if (cp !== undefined && isFinite(cp) && cp >= 0) {
        return cp;
    }
    if (mid !== null && mid > 0) {
        return mid;
    }
    return 0;
};

/**
 * 代理钱包持仓总市值（USD）。
 * - 传入 `clobClient`：每条仓位用 `resolveTokenMarkUsd`（curPrice 与盘口背离时用 mid）。
 * - 不传：仅 positions API 的 curPrice（旧行为，无订单簿请求）。
 */
export const getProxyPortfolioMarkUsd = async (clobClient?: ClobClient): Promise<number> => {
    await refreshCurPriceMap(false);
    try {
        const rows: unknown = await fetchPositionsForUser(ENV.PROXY_WALLET);
        if (!Array.isArray(rows)) return 0;
        let total = 0;
        for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            const pos = row as Record<string, unknown>;
            const asset = pos.asset;
            if (typeof asset !== 'string' || !asset) continue;
            const size =
                typeof pos.size === 'number' ? pos.size : parseFloat(String(pos.size || 0));
            if (!isFinite(size) || size <= 0) continue;

            const rowCp = parseRowCurPrice(pos);
            const conditionId =
                typeof pos.conditionId === 'string' && pos.conditionId ? pos.conditionId : undefined;
            let mark: number;
            if (clobClient) {
                mark = await resolveTokenMarkUsd(clobClient, asset, {
                    curPriceHint: rowCp ?? undefined,
                    conditionId,
                });
            } else {
                mark = rowCp ?? 0;
            }
            if (mark > 0 && isFinite(mark)) {
                total += size * mark;
            }
        }
        return total;
    } catch {
        return 0;
    }
};
