import { ENV } from '../config/env';
import { fetchPositionsForUser, fetchPositionsForUserForce } from './dataApiCache';

/**
 * Polymarket Data API positions include `curPrice` (mark) per outcome token.
 * We merge positions from proxy + followed traders so simulated/real holdings
 * can be valued consistently with the same field the UI uses.
 */

type CurPriceEntry = { price: number; fetchedAt: number };

const cacheByAsset: Map<string, CurPriceEntry> = new Map();
let lastBulkFetchAt = 0;

const getTtlMs = (): number => ENV.CUR_PRICE_CACHE_TTL_MS;

const parseCurPrice = (p: Record<string, unknown>): number | null => {
    const v = p.curPrice;
    // 已结算输的一侧常为 0；原先用 >0 会漏掉，导致 isMarketResolved 永远为 false
    if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
    if (typeof v === 'string') {
        const n = parseFloat(v);
        if (isFinite(n) && n >= 0) return n;
    }
    return null;
};

/**
 * Refresh in-memory curPrice map from Polymarket positions API (proxy + traders).
 */
export const refreshCurPriceMap = async (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastBulkFetchAt < getTtlMs()) {
        return;
    }
    lastBulkFetchAt = now;

    const addresses = [ENV.PROXY_WALLET, ...ENV.USER_ADDRESSES];
    const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];

    for (const addr of unique) {
        try {
            const rows: unknown = force
                ? await fetchPositionsForUserForce(addr)
                : await fetchPositionsForUser(addr);
            if (!Array.isArray(rows)) continue;
            for (const row of rows) {
                if (!row || typeof row !== 'object') continue;
                const pos = row as Record<string, unknown>;
                const asset = pos.asset;
                if (typeof asset !== 'string' || !asset) continue;
                const px = parseCurPrice(pos);
                if (px !== null) {
                    cacheByAsset.set(asset, { price: px, fetchedAt: now });
                }
            }
        } catch {
            // ignore per-wallet errors
        }
    }
};

/**
 * Best-effort curPrice for a token id. Returns undefined if unknown.
 */
export const getCurPriceForAsset = async (asset: string, force = false): Promise<number | undefined> => {
    await refreshCurPriceMap(force);
    return cacheByAsset.get(asset)?.price;
};

