import { normalizeClobAssetId } from './clobIds';

/** 与 positions / watch 的 asset 对齐，避免因 token id 格式差异导致止盈 watch 永远匹配不到持仓 */
export const makePositionKey = (conditionId: string, asset: string): string =>
    `${conditionId}:${normalizeClobAssetId(asset)}`.toLowerCase();

/**
 * Positions API 在极低价（如 1¢）仓位上常把 avgPrice / initialValue 置为 0 或严重舍入，
 * 若仍用 pos.avgPrice 做止盈前的盘口校验，会跳过「预估成交额 / 可执行 PnL」保护并误报止盈。
 * 优先用 API 均价；无效时用本地记录的投入 ÷ 持仓数量作为参考成本价。
 */
export const resolveRefAvgPriceForExit = (opts: {
    posAvgPrice: unknown;
    trackedCostBasisUsd: number;
    size: number;
}): number => {
    const raw = opts.posAvgPrice;
    const a =
        typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : Number(raw);
    if (Number.isFinite(a) && a > 0) return a;
    if (opts.trackedCostBasisUsd > 0 && opts.size > 0) {
        return opts.trackedCostBasisUsd / opts.size;
    }
    return 0;
};

export const getPercentPnlFromPosition = (pos: any): number | null => {
    const percentPnl = pos?.percentPnl;
    if (typeof percentPnl === 'number' && Number.isFinite(percentPnl)) return percentPnl;

    const initialValue = pos?.initialValue;
    const currentValue = pos?.currentValue;
    if (
        typeof initialValue === 'number' &&
        typeof currentValue === 'number' &&
        Number.isFinite(initialValue) &&
        Number.isFinite(currentValue) &&
        initialValue !== 0
    ) {
        return ((currentValue - initialValue) / initialValue) * 100;
    }

    return null;
};

export const getPercentPnlFromAvgAndPx = (avgPrice: number, pxUsed: number): number | null => {
    if (!Number.isFinite(avgPrice) || avgPrice <= 0) return null;
    if (!Number.isFinite(pxUsed) || pxUsed < 0) return null;
    return ((pxUsed - avgPrice) / avgPrice) * 100;
};

/**
 * Positions API 未返回 percentPnl / initialValue 时，用 avgPrice+curPrice 或 currentValue/size 推算 ROI，
 * 减少「接口字段缺失导致永远不触发止盈/止损」。
 */
export const resolvePercentPnlForProfitExit = (pos: any): number | null => {
    const fromApi = getPercentPnlFromPosition(pos);
    if (fromApi != null) return fromApi;

    const avg =
        typeof pos?.avgPrice === 'number' && Number.isFinite(pos.avgPrice) && pos.avgPrice > 0
            ? pos.avgPrice
            : null;
    const cur =
        typeof pos?.curPrice === 'number' && Number.isFinite(pos.curPrice) && pos.curPrice >= 0
            ? pos.curPrice
            : null;
    if (avg != null && cur != null) {
        return getPercentPnlFromAvgAndPx(avg, cur);
    }

    const size =
        typeof pos?.size === 'number' && Number.isFinite(pos.size) && pos.size > 0 ? pos.size : 0;
    const cv =
        typeof pos?.currentValue === 'number' &&
        Number.isFinite(pos.currentValue) &&
        pos.currentValue >= 0
            ? pos.currentValue
            : null;
    if (avg != null && size > 0 && cv != null) {
        const impliedPx = cv / size;
        return getPercentPnlFromAvgAndPx(avg, impliedPx);
    }

    return null;
};

export const shouldTriggerProfitExit = (opts: {
    percentPnl: number;
    takeProfitPct: number;
    stopLossPct: number;
}): { triggered: boolean; reason: string } => {
    const { percentPnl, takeProfitPct, stopLossPct } = opts;

    // takeProfitPct / stopLossPct <= 0 表示关闭该侧，避免 TP=0 变成「任意非负即止盈」、SL=0 变成「任意浮亏即止损」
    if (takeProfitPct > 0 && percentPnl >= takeProfitPct) {
        return {
            triggered: true,
            reason: `take-profit (${percentPnl.toFixed(2)}% >= ${takeProfitPct.toFixed(2)}%)`,
        };
    }
    if (stopLossPct > 0 && percentPnl <= -stopLossPct) {
        return {
            triggered: true,
            reason: `stop-loss (${percentPnl.toFixed(2)}% <= -${stopLossPct.toFixed(2)}%)`,
        };
    }

    return { triggered: false, reason: '' };
};

/** 日志展示：<=0 表示该侧已关闭 */
export const formatTpSlThresholdsZh = (takeProfitPct: number, stopLossPct: number): string => {
    const tp = takeProfitPct > 0 ? `TP ${takeProfitPct.toFixed(2)}%` : 'TP 关闭';
    const sl = stopLossPct > 0 ? `SL -${stopLossPct.toFixed(2)}%` : 'SL 关闭';
    return `${tp} / ${sl}`;
};

export const estimateSellPnlPctFromBids = (opts: {
    avgPrice: number;
    size: number;
    bids: Array<{ price?: string | number; size?: string | number }>;
    minPrice?: number;
    maxPrice?: number;
}): number | null => {
    const {
        avgPrice,
        size,
        bids,
        minPrice = 0.01,
        maxPrice = 0.99,
    } = opts;
    if (!Number.isFinite(avgPrice) || avgPrice <= 0) return null;
    if (!Number.isFinite(size) || size <= 0) return null;
    if (!Array.isArray(bids) || bids.length === 0) return null;

    const levels = bids
        .map((b) => ({
            price: parseFloat(String(b?.price ?? 'NaN')),
            size: parseFloat(String(b?.size ?? 'NaN')),
        }))
        .filter(
            (x) =>
                Number.isFinite(x.price) &&
                x.price >= minPrice &&
                x.price <= maxPrice &&
                Number.isFinite(x.size) &&
                x.size > 0
        )
        .sort((a, b) => b.price - a.price);

    if (levels.length === 0) return null;

    let remaining = size;
    let sold = 0;
    let proceeds = 0;
    for (const lv of levels) {
        if (remaining <= 0) break;
        const fill = Math.min(remaining, lv.size);
        sold += fill;
        proceeds += fill * lv.price;
        remaining -= fill;
    }
    if (sold <= 0) return null;

    const avgExecPx = proceeds / sold;
    return ((avgExecPx - avgPrice) / avgPrice) * 100;
};

export const estimateSellProceedsFromBids = (opts: {
    size: number;
    bids: Array<{ price?: string | number; size?: string | number }>;
    minPrice?: number;
    maxPrice?: number;
}): { proceeds: number; sold: number } | null => {
    const { size, bids, minPrice = 0.01, maxPrice = 0.99 } = opts;
    if (!Number.isFinite(size) || size <= 0) return null;
    if (!Array.isArray(bids) || bids.length === 0) return null;

    const levels = bids
        .map((b) => ({
            price: parseFloat(String(b?.price ?? 'NaN')),
            size: parseFloat(String(b?.size ?? 'NaN')),
        }))
        .filter(
            (x) =>
                Number.isFinite(x.price) &&
                x.price >= minPrice &&
                x.price <= maxPrice &&
                Number.isFinite(x.size) &&
                x.size > 0
        )
        .sort((a, b) => b.price - a.price);

    if (levels.length === 0) return null;

    let remaining = size;
    let sold = 0;
    let proceeds = 0;
    for (const lv of levels) {
        if (remaining <= 0) break;
        const fill = Math.min(remaining, lv.size);
        sold += fill;
        proceeds += fill * lv.price;
        remaining -= fill;
    }
    return { proceeds, sold };
};

