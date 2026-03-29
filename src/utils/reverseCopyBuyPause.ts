/**
 * 反买(REVERSE)：在「我方已平掉 opposite 腿」或「触达最大仓位无法再加仓」后，
 * 暂停跟随新的「交易员 BUY → 我方 BUY」，直到 Data API 显示交易员在监控腿上的持仓接近 0。
 * 避免：止盈/同步卖完后，交易员仍在同市场加仓，机器人又在高位反买接回。
 */
import { ENV } from '../config/env';
import type { UserPositionInterface } from '../interfaces/User';
import { getConditionTokensMetaCached } from './conditionTokens';
import { normalizeClobAssetId } from './clobIds';
import Logger from './logger';

const TRADER_FLAT_EPS = 1e-4;
const MAX_PAUSE_ENTRIES = 2000;

type PauseEntry = {
    monitorTraderAsset: string;
    reason: string;
    setAt: number;
};

const pauseByKey = new Map<string, PauseEntry>();

export const reverseBuyPauseKey = (conditionId: string, myAsset: string): string =>
    `${conditionId}:${normalizeClobAssetId(myAsset)}`.toLowerCase();

const prunePauses = (): void => {
    if (pauseByKey.size <= MAX_PAUSE_ENTRIES) return;
    const sorted = [...pauseByKey.entries()].sort((a, b) => a[1].setAt - b[1].setAt);
    while (pauseByKey.size > MAX_PAUSE_ENTRIES && sorted.length > 0) {
        const first = sorted.shift();
        if (first) pauseByKey.delete(first[0]);
    }
};

export const setReverseCopyBuyPause = (opts: {
    conditionId: string;
    myAsset: string;
    monitorTraderAsset: string;
    reason: string;
}): void => {
    if (!ENV.COPY_REVERSE_PAUSE_NEW_BUYS_UNTIL_TRADER_FLAT) return;
    const mon = normalizeClobAssetId(opts.monitorTraderAsset);
    if (!mon) return;
    const key = reverseBuyPauseKey(opts.conditionId, opts.myAsset);
    pauseByKey.set(key, {
        monitorTraderAsset: mon,
        reason: opts.reason,
        setAt: Date.now(),
    });
    prunePauses();
    Logger.info(
        `🧷 [反买暂停跟买] reason=${opts.reason} | condition=${opts.conditionId.slice(0, 12)}... 我方腿=${normalizeClobAssetId(opts.myAsset).slice(0, 12)}... 监控交易员腿=${mon.slice(0, 12)}...（该腿空仓后自动恢复）`
    );
};

/** 自动止盈/止损卖的是我方 token：二元市场用「另一枚 clob token」作为交易员腿监控 */
export const setReverseCopyBuyPauseAfterAutoExit = async (opts: {
    conditionId: string;
    myAsset: string;
}): Promise<void> => {
    if (!ENV.COPY_REVERSE_PAUSE_NEW_BUYS_UNTIL_TRADER_FLAT) return;
    const other = await inferOtherLegTokenId(opts.conditionId, opts.myAsset);
    if (!other) {
        Logger.warning(
            `[反买暂停跟买] 无法推断二元另一腿 token，跳过设置暂停 | condition=${opts.conditionId.slice(0, 12)}...`
        );
        return;
    }
    setReverseCopyBuyPause({
        conditionId: opts.conditionId,
        myAsset: opts.myAsset,
        monitorTraderAsset: other,
        reason: 'AUTO_PROFIT_EXIT',
    });
};

const inferOtherLegTokenId = async (
    conditionId: string,
    myAsset: string
): Promise<string | undefined> => {
    try {
        const { tokenIds: raw } = await getConditionTokensMetaCached(conditionId);
        const ids = raw.map(normalizeClobAssetId).filter(Boolean);
        const me = normalizeClobAssetId(myAsset);
        if (ids.length !== 2) return undefined;
        const other = ids.find((id) => id !== me);
        return other;
    } catch {
        return undefined;
    }
};

/**
 * 若存在暂停记录且交易员监控腿仍有仓 → 跳过本次反买 BUY。
 * 若交易员该腿已空仓 → 清除暂停并允许跟买。
 */
export const evaluateReverseBuyPauseSkip = (opts: {
    conditionId: string;
    myBuyAsset: string;
    traderPositions: UserPositionInterface[];
}): { skip: boolean; detail?: string } => {
    if (!ENV.COPY_REVERSE_PAUSE_NEW_BUYS_UNTIL_TRADER_FLAT) return { skip: false };
    const key = reverseBuyPauseKey(opts.conditionId, opts.myBuyAsset);
    const entry = pauseByKey.get(key);
    if (!entry) return { skip: false };

    const mon = entry.monitorTraderAsset;
    const tp = opts.traderPositions.find(
        (p) =>
            p.conditionId === opts.conditionId && normalizeClobAssetId(p.asset) === mon
    );
    const traderSize = tp?.size ?? 0;
    if (!tp || traderSize < TRADER_FLAT_EPS) {
        pauseByKey.delete(key);
        Logger.info(
            `🔓 [反买暂停跟买] 交易员监控腿已空仓，恢复跟买 | condition=${opts.conditionId.slice(0, 12)}...`
        );
        return { skip: false };
    }

    return {
        skip: true,
        detail: `反买会话暂停(${entry.reason})：交易员该 outcome 仍有持仓 ${traderSize.toFixed(4)} tokens，空仓后自动恢复跟买`,
    };
};
