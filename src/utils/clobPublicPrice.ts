import { ENV } from '../config/env';
import fetchData from './fetchData';

type CacheEntry = { fetchedAt: number; value: number | null };
const cache = new Map<string, CacheEntry>();

const getTtl = (): number => ENV.CLOB_LIGHT_PRICE_CACHE_TTL_MS;

const clobBaseUrl = (): string => (ENV.CLOB_HTTP_URL || 'https://clob.polymarket.com').replace(/\/+$/, '');

/** 解析 CLOB /midpoint、/last-trade-price 等返回的 JSON */
const parseClobPricePayload = (data: unknown): number | null => {
    if (data == null) return null;
    if (typeof data === 'number' && isFinite(data) && data >= 0) {
        return Math.max(0, Math.min(1, data));
    }
    if (typeof data === 'string') {
        const n = parseFloat(data);
        if (isFinite(n) && n >= 0) return Math.max(0, Math.min(1, n));
    }
    if (typeof data === 'object') {
        const o = data as Record<string, unknown>;
        for (const k of ['mid', 'price', 'midpoint', 'last_trade_price', 'lastTradePrice', 'p']) {
            const v = o[k];
            if (typeof v === 'number' && isFinite(v) && v >= 0) {
                return Math.max(0, Math.min(1, v));
            }
            if (typeof v === 'string') {
                const n = parseFloat(v);
                if (isFinite(n) && n >= 0) return Math.max(0, Math.min(1, n));
            }
        }
    }
    return null;
};

const tryFetchPrice = async (path: string, tokenId: string): Promise<number | null> => {
    const url = `${clobBaseUrl()}${path}?token_id=${encodeURIComponent(tokenId)}`;
    try {
        const data = await fetchData(url);
        return parseClobPricePayload(data);
    } catch {
        return null;
    }
};

/**
 * 公开 CLOB 轻量价格：优先 midpoint，其次 last-trade-price。
 * 不拉整本订单簿，减少负载与 404 日志；失败返回 null。
 */
export const fetchClobLightPriceUsdCached = async (tokenId: string): Promise<number | null> => {
    const now = Date.now();
    const ttl = getTtl();
    const hit = cache.get(tokenId);
    if (hit && now - hit.fetchedAt < ttl) {
        return hit.value;
    }

    const value: number | null =
        (await tryFetchPrice('/midpoint', tokenId)) ?? (await tryFetchPrice('/last-trade-price', tokenId));

    cache.set(tokenId, { fetchedAt: now, value });
    while (cache.size > ENV.ORDERBOOK_CACHE_MAX_ENTRIES) {
        const first = cache.keys().next().value;
        if (!first) break;
        cache.delete(first);
    }
    return value;
};
