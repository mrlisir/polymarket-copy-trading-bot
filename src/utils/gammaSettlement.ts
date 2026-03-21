import fetchData from './fetchData';

/** 与 positionReconciliationCore.isMarketResolved 阈值对齐 */
const SETTLED_HIGH = 0.99;
const SETTLED_LOW = 0.01;

type CacheEntry = { fetchedAt: number; info: GammaSettlementCacheValue };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

export type GammaSettlementCacheValue =
    | { status: 'not_found' }
    | { status: 'open' }
    | {
          status: 'closed';
          /** token_id -> 每份兑付 USD [0,1]（来自 Gamma outcomePrices） */
          tokenToUsd: Map<string, number>;
      };

const parseJsonStringArray = (raw: unknown): string[] => {
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
        const a = JSON.parse(raw) as unknown;
        return Array.isArray(a) ? a.map((x) => String(x)) : [];
    } catch {
        return [];
    }
};

/**
 * 从 Gamma 拉取市场：closed 时根据 clobTokenIds 与 outcomePrices 对齐得到各 token 结算价。
 * 用于模拟对账：Data API 的 curPrice/redeemable 在「仅模拟、代理钱包无仓」时经常缺失或滞后。
 */
export const fetchGammaSettlementInfoCached = async (
    conditionId: string
): Promise<GammaSettlementCacheValue> => {
    const now = Date.now();
    const hit = cache.get(conditionId);
    if (hit && now - hit.fetchedAt < TTL_MS) {
        return hit.info;
    }

    let info: GammaSettlementCacheValue = { status: 'not_found' };
    try {
        const raw = await fetchData(
            `https://gamma-api.polymarket.com/markets?condition_id=${encodeURIComponent(conditionId)}`
        );
        const markets = Array.isArray(raw) ? raw : [];
        const market = markets[0] as Record<string, unknown> | undefined;
        if (!market) {
            info = { status: 'not_found' };
        } else if (market.closed !== true) {
            info = { status: 'open' };
        } else {
            const tokens = parseJsonStringArray(market.clobTokenIds);
            const priceStrs = parseJsonStringArray(market.outcomePrices);
            if (
                tokens.length < 2 ||
                tokens.length !== priceStrs.length
            ) {
                info = { status: 'closed', tokenToUsd: new Map() };
            } else {
                const tokenToUsd = new Map<string, number>();
                for (let i = 0; i < tokens.length; i++) {
                    const p = parseFloat(priceStrs[i]);
                    if (!isFinite(p)) continue;
                    tokenToUsd.set(tokens[i], Math.max(0, Math.min(1, p)));
                }
                info = { status: 'closed', tokenToUsd };
            }
        }
    } catch {
        info = { status: 'not_found' };
    }

    cache.set(conditionId, { fetchedAt: now, info });
    return info;
};

/** Gamma 已关闭且该 token 的 outcome 价格已贴近 0/1（可安全用于模拟结算） */
export const gammaTokenLooksSettled = (
    info: GammaSettlementCacheValue,
    asset: string
): { settled: boolean; settlementPx?: number } => {
    if (info.status !== 'closed') return { settled: false };
    const px = info.tokenToUsd.get(asset);
    if (px === undefined || !isFinite(px)) return { settled: false };
    if (px >= SETTLED_HIGH || px <= SETTLED_LOW) {
        return { settled: true, settlementPx: px };
    }
    return { settled: false };
};

/**
 * 已收盘市场：用 Gamma outcome 价做展示估值（不要求贴 0/1），不依赖 CLOB 订单簿是否存在。
 */
export const gammaClosedValuationUsd = (
    info: GammaSettlementCacheValue,
    asset: string
): number | undefined => {
    if (info.status !== 'closed') return undefined;
    const px = info.tokenToUsd.get(asset);
    if (px === undefined || !isFinite(px)) return undefined;
    return px;
};

export const getGammaValuationUsdForAsset = async (
    conditionId: string | undefined,
    asset: string
): Promise<number | undefined> => {
    if (!conditionId) return undefined;
    const info = await fetchGammaSettlementInfoCached(conditionId);
    return gammaClosedValuationUsd(info, asset);
};
