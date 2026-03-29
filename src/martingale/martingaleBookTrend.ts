/**
 * @author li.mingfeng
 * 待收盘日志 / 趋势跟单入场：用 CLOB 轻量价（midpoint/最近成交）对比 Up/Down 两侧；失败时回退 Gamma outcomePrices。
 */

import { fetchClobLightPriceUsdCached } from '../utils/clobPublicPrice';
import type { GammaMarketLite } from './martingaleMarket';
import { parseClobTokenIds, parseJsonArrayField, parseOutcomePrices } from './martingaleMarket';

const fmtPx = (n: number): string => n.toFixed(2);

export type MartingaleBinaryTrend = {
    price0: number;
    price1: number;
    source: 'CLOB' | 'Gamma';
    label0: string;
    label1: string;
};

/**
 * 解析二元市场两侧隐含价（与日志「趋势结果」同源）。
 */
export const resolveMartingaleBinaryTrend = async (
    m: GammaMarketLite
): Promise<MartingaleBinaryTrend | null> => {
    const labels = parseJsonArrayField(m.outcomes);
    const tokenIds = parseClobTokenIds(m);
    if (labels.length < 2) {
        return null;
    }
    const label0 = (labels[0] && String(labels[0]).trim()) || 'A';
    const label1 = (labels[1] && String(labels[1]).trim()) || 'B';

    let a: number | null = null;
    let b: number | null = null;
    let source: 'CLOB' | 'Gamma' = 'CLOB';

    if (tokenIds.length >= 2 && tokenIds[0] && tokenIds[1]) {
        a = await fetchClobLightPriceUsdCached(tokenIds[0]);
        b = await fetchClobLightPriceUsdCached(tokenIds[1]);
    }
    if (a == null && b != null && Number.isFinite(b)) {
        a = Math.max(0, Math.min(1, 1 - b));
    }
    if (b == null && a != null && Number.isFinite(a)) {
        b = Math.max(0, Math.min(1, 1 - a));
    }
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) {
        const gp = parseOutcomePrices(m.outcomePrices);
        if (gp.length >= 2) {
            a = gp[0];
            b = gp[1];
            source = 'Gamma';
        } else {
            return null;
        }
    }

    return {
        price0: a,
        price1: b,
        source,
        label0,
        label1,
    };
};

/**
 * 返回可插入日志的短句（不含外层括号）；失败返回 null。
 */
export const martingaleTrendHintFromOrderBook = async (m: GammaMarketLite): Promise<string | null> => {
    const t = await resolveMartingaleBinaryTrend(m);
    if (!t) {
        return null;
    }
    const hi = t.price0 >= t.price1 ? t.label0 : t.label1;
    const tie = Math.abs(t.price0 - t.price1) < 0.008;
    const bias = tie ? '两侧接近' : `偏高为 ${hi}`;
    return `趋势结果·${t.source}: ${t.label0}:${fmtPx(t.price0)} ${t.label1}:${fmtPx(t.price1)}，${bias}`;
};
