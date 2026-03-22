import fetchData from './fetchData';
import { normalizeClobAssetId } from './clobIds';

type Entry = { fetchedAt: number; tokenIds: string[]; outcomes: string[] };
const cache = new Map<string, Entry>();
const TTL_MS = 60_000;

const parseOutcomes = (market: Record<string, unknown>): string[] => {
    const raw = market.outcomes;
    if (typeof raw === 'string' && raw.trim()) {
        try {
            const arr = JSON.parse(raw) as unknown;
            if (Array.isArray(arr)) {
                return arr.map((v) => String(v).trim()).filter(Boolean);
            }
        } catch {
            // ignore
        }
    }
    return [];
};

const parseTokenIds = (market: Record<string, unknown>): string[] => {
    const out = new Set<string>();
    const raw = market.clobTokenIds;
    if (typeof raw === 'string' && raw.trim()) {
        try {
            const arr = JSON.parse(raw) as unknown;
            if (Array.isArray(arr)) {
                for (const v of arr) {
                    const s = String(v).trim();
                    if (s) out.add(s);
                }
            }
        } catch {
            // ignore
        }
    }
    const oa = market.outcomeAssets;
    if (Array.isArray(oa)) {
        for (const v of oa) {
            const s = String(v).trim();
            if (s) out.add(s);
        }
    }
    return [...out];
};

/**
 * 从 Gamma 拉取 condition 下的 clobTokenIds 与 outcomes（下标一一对应）。
 */
/** 清除 Gamma token 元数据缓存（可选指定 conditionId，小写归一化键） */
export const invalidateConditionTokensCache = (conditionId?: string): void => {
    if (conditionId) cache.delete(conditionId.trim().toLowerCase());
    else cache.clear();
};

export const getConditionTokensMetaCached = async (
    conditionId: string
): Promise<{ tokenIds: string[]; outcomes: string[] }> => {
    const normId = conditionId.trim().toLowerCase();
    const now = Date.now();
    const hit = cache.get(normId);
    if (hit && now - hit.fetchedAt < TTL_MS) {
        return { tokenIds: hit.tokenIds, outcomes: hit.outcomes };
    }

    try {
        // Gamma 须用 condition_ids；condition_id 会被忽略并返回无关市场（导致反买对侧解析失败）
        const raw = await fetchData(
            `https://gamma-api.polymarket.com/markets?condition_ids=${encodeURIComponent(conditionId.trim())}`
        );
        const markets = Array.isArray(raw) ? raw : [];
        for (const m of markets) {
            if (!m || typeof m !== 'object') continue;
            const market = m as Record<string, unknown>;
            const cid = String(market.conditionId || market.condition_id || '').trim();
            if (cid && cid.toLowerCase() !== normId) continue;
            const tokenIds = parseTokenIds(market);
            const outcomes = parseOutcomes(market);
            if (tokenIds.length >= 2) {
                const entry: Entry = { fetchedAt: now, tokenIds, outcomes };
                cache.set(normId, entry);
                return { tokenIds, outcomes };
            }
        }
    } catch (err) {
        console.warn('[conditionTokens] Gamma markets 请求失败（不写入空缓存，可稍后重试）:', err);
        return { tokenIds: [], outcomes: [] };
    }

    const empty: Entry = { fetchedAt: now, tokenIds: [], outcomes: [] };
    cache.set(normId, empty);
    return { tokenIds: [], outcomes: [] };
};

export const getConditionTokenIdsCached = async (conditionId: string): Promise<string[]> => {
    const { tokenIds } = await getConditionTokensMetaCached(conditionId);
    return tokenIds;
};

/** outcomes[i] 与 tokenIds[i] 对齐（Gamma 约定） */
export const outcomeLabelForAsset = (
    tokenIds: string[],
    outcomes: string[],
    asset: string
): string | undefined => {
    const i = tokenIds.indexOf(asset);
    if (i < 0) return undefined;
    return outcomes[i] || undefined;
};

export const resolveReverseAssetForCondition = async (
    conditionId: string,
    traderAsset: string,
    candidateOpposite?: string
): Promise<{ oppositeAsset?: string; valid: boolean; tokenIds: string[] }> => {
    const ta = normalizeClobAssetId(traderAsset);
    const co = candidateOpposite ? normalizeClobAssetId(candidateOpposite) : undefined;
    const { tokenIds: rawIds } = await getConditionTokensMetaCached(conditionId);
    const tokenIds = rawIds.map((id) => normalizeClobAssetId(id));
    if (tokenIds.length < 2) {
        return { oppositeAsset: co || candidateOpposite, valid: false, tokenIds };
    }
    const hasTrader = tokenIds.includes(ta);
    const inferred = tokenIds.find((id) => id !== ta);

    let oppositeAsset: string | undefined;

    if (tokenIds.length === 2 && hasTrader && inferred) {
        // 二元市场：始终以 Gamma 的另一枚 clob token 为对侧，避免 Data API 的 oppositeAsset 与 outcome 标反时跟成同腿
        oppositeAsset = inferred;
    } else if (co && tokenIds.includes(co) && co !== ta) {
        oppositeAsset = co;
    } else {
        oppositeAsset = inferred;
    }

    const valid = Boolean(hasTrader && oppositeAsset && oppositeAsset !== ta);
    return { oppositeAsset, valid, tokenIds };
};

