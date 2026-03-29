/**
 * @author li.mingfeng
 * 理论窗结束后：用 CLOB midpoint/last-trade 两侧价格谁高谁赢，做快速结算（不等 Gamma closed）。
 */

import { fetchClobLightPriceUsdCached } from '../utils/clobPublicPrice';
import type { GammaMarketLite } from './martingaleMarket';
import { parseClobTokenIds, parseJsonArrayField } from './martingaleMarket';

/**
 * 若两侧价均可得（或一侧推 1-另一侧），且 |a-b| >= minSpread（minSpread=0 则不要求价差），
 * 返回胜出 outcome 索引 0 或 1（价高者胜，相等视为 0 胜）。
 */
export const provisionalWinnerFromClobMidPrices = async (
    m: GammaMarketLite,
    minSpread: number
): Promise<number | null> => {
    const labels = parseJsonArrayField(m.outcomes);
    const tokenIds = parseClobTokenIds(m);
    if (labels.length < 2 || tokenIds.length < 2) {
        return null;
    }
    const t0 = tokenIds[0] || '';
    const t1 = tokenIds[1] || '';
    if (!t0 || !t1) {
        return null;
    }
    let a = await fetchClobLightPriceUsdCached(t0);
    let b = await fetchClobLightPriceUsdCached(t1);
    if (a == null && b != null && Number.isFinite(b)) {
        a = Math.max(0, Math.min(1, 1 - b));
    }
    if (b == null && a != null && Number.isFinite(a)) {
        b = Math.max(0, Math.min(1, 1 - a));
    }
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) {
        return null;
    }
    if (minSpread > 0 && Math.abs(a - b) < minSpread) {
        return null;
    }
    return a >= b ? 0 : 1;
};
