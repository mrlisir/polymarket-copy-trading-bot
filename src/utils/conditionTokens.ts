import fetchData from './fetchData';

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
export const getConditionTokensMetaCached = async (
    conditionId: string
): Promise<{ tokenIds: string[]; outcomes: string[] }> => {
    const now = Date.now();
    const hit = cache.get(conditionId);
    if (hit && now - hit.fetchedAt < TTL_MS) {
        return { tokenIds: hit.tokenIds, outcomes: hit.outcomes };
    }

    try {
        const raw = await fetchData(
            `https://gamma-api.polymarket.com/markets?condition_id=${encodeURIComponent(conditionId)}`
        );
        const markets = Array.isArray(raw) ? raw : [];
        for (const m of markets) {
            if (!m || typeof m !== 'object') continue;
            const market = m as Record<string, unknown>;
            const cid = String(market.conditionId || market.condition_id || '').trim();
            if (cid && cid !== conditionId) continue;
            const tokenIds = parseTokenIds(market);
            const outcomes = parseOutcomes(market);
            if (tokenIds.length >= 2) {
                const entry: Entry = { fetchedAt: now, tokenIds, outcomes };
                cache.set(conditionId, entry);
                return { tokenIds, outcomes };
            }
        }
    } catch {
        // ignore
    }

    const empty: Entry = { fetchedAt: now, tokenIds: [], outcomes: [] };
    cache.set(conditionId, empty);
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
    const { tokenIds } = await getConditionTokensMetaCached(conditionId);
    if (tokenIds.length < 2) {
        return { oppositeAsset: candidateOpposite, valid: false, tokenIds };
    }
    const hasTrader = tokenIds.includes(traderAsset);
    const inferred = tokenIds.find((id) => id !== traderAsset);

    let oppositeAsset: string | undefined;

    if (tokenIds.length === 2 && hasTrader && inferred) {
        // 二元市场：始终以 Gamma 的另一枚 clob token 为对侧，避免 Data API 的 oppositeAsset 与 outcome 标反时跟成同腿
        oppositeAsset = inferred;
    } else if (
        candidateOpposite &&
        tokenIds.includes(candidateOpposite) &&
        candidateOpposite !== traderAsset
    ) {
        oppositeAsset = candidateOpposite;
    } else {
        oppositeAsset = inferred;
    }

    const valid = Boolean(hasTrader && oppositeAsset && oppositeAsset !== traderAsset);
    return { oppositeAsset, valid, tokenIds };
};

