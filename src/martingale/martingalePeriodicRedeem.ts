/**
 * @author li.mingfeng
 * 马丁格尔实盘：按间隔扫描 Data API 可赎回仓位并链上 redeemPositions（与 npm run redeem-resolved 判定一致）。
 */

import { ENV } from '../config/env';
import { RESOLVED_HIGH, RESOLVED_LOW } from '../services/positionReconciliationCore';
import { assertPolygonGasForRedeem, redeemPolymarketCondition } from '../utils/ctfRedeem';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';

const ZERO_THRESHOLD = 0.0001;

type DataPosition = {
    conditionId?: string;
    size?: number;
    curPrice?: number;
    redeemable?: boolean;
    title?: string;
};

/**
 * 拉取 PROXY_WALLET 在 Data API 的 positions，筛出与 redeem-resolved 脚本一致的可赎回 condition，逐个链上赎回。
 * @returns attempted 尝试的 condition 数；ok 链上成功数
 */
export const runMartingalePeriodicRedeem = async (): Promise<{ attempted: number; ok: number }> => {
    const w = (ENV.PROXY_WALLET || '').trim();
    if (!w) {
        Logger.warning('[马丁·定期赎回] PROXY_WALLET 为空，跳过');
        return { attempted: 0, ok: 0 };
    }
    const gasOk = await assertPolygonGasForRedeem();
    if (!gasOk) {
        return { attempted: 0, ok: 0 };
    }
    const url = `https://data-api.polymarket.com/positions?user=${encodeURIComponent(w)}`;
    const data = (await fetchData(url)) as unknown;
    const rows = Array.isArray(data) ? (data as DataPosition[]) : [];
    const filtered = rows.filter(
        (p) =>
            (p.size || 0) > ZERO_THRESHOLD &&
            p.redeemable === true &&
            typeof p.conditionId === 'string' &&
            p.conditionId.trim() !== '' &&
            typeof p.curPrice === 'number' &&
            Number.isFinite(p.curPrice) &&
            (p.curPrice >= RESOLVED_HIGH || p.curPrice <= RESOLVED_LOW)
    );
    const ids = [...new Set(filtered.map((p) => String(p.conditionId).trim()))];
    if (ids.length === 0) {
        return { attempted: 0, ok: 0 };
    }
    Logger.info(`[马丁·定期赎回] 发现 ${ids.length} 个可赎回 condition，开始链上 redeem…`);
    let ok = 0;
    for (let i = 0; i < ids.length; i += 1) {
        const cid = ids[i];
        const success = await redeemPolymarketCondition(cid);
        if (success) {
            ok += 1;
        }
        if (i < ids.length - 1) {
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
    Logger.info(`[马丁·定期赎回] 本轮结束 attempted=${ids.length} success=${ok}`);
    return { attempted: ids.length, ok };
};
