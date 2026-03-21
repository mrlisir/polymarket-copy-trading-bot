import { ENV } from '../config/env';
import fetchData from './fetchData';

type PositionsEntry = { fetchedAt: number; rows: unknown[] };

const positionsByUser = new Map<string, PositionsEntry>();

const normUser = (u: string): string => u.toLowerCase();

const getPositionsTtl = (): number => ENV.DATA_API_POSITIONS_CACHE_TTL_MS;

/**
 * Data API `positions?user=` 带 TTL 缓存，供 curPrice 刷新、tradeMonitor、对账、dry run 等共用，减少重复请求。
 */
export const fetchPositionsForUser = async (
    user: string,
    opts?: { force?: boolean }
): Promise<unknown[]> => {
    const key = normUser(user);
    const now = Date.now();
    const ttl = getPositionsTtl();
    const hit = positionsByUser.get(key);
    if (!opts?.force && hit && now - hit.fetchedAt < ttl) {
        return hit.rows;
    }

    try {
        const raw = await fetchData(`https://data-api.polymarket.com/positions?user=${user}`);
        const rows = Array.isArray(raw) ? raw : [];
        positionsByUser.set(key, { fetchedAt: now, rows });
        return rows;
    } catch {
        if (hit) {
            return hit.rows;
        }
        return [];
    }
};

/** 强制拉最新持仓（例如 curPrice 强制刷新） */
export const fetchPositionsForUserForce = (user: string): Promise<unknown[]> =>
    fetchPositionsForUser(user, { force: true });
