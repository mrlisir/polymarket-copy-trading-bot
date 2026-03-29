import { CopyMode } from '../config/copyStrategy';
import { ENV, getCopyModeForTrader } from '../config/env';
import { UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { fetchPositionsForUser } from '../utils/dataApiCache';
import { normalizeClobAssetId } from '../utils/clobIds';

/** 与 postOrder / dryRun 卖出最小代币数对齐 */
export const RECONCILE_MIN_SELL_TOKENS = 1.0;
export const RESOLVED_HIGH = 0.99;
export const RESOLVED_LOW = 0.01;
/** 交易员镜像腿仍视为「有仓」的最小代币数 */
export const TRADER_MIRROR_MIN = 0.25;

export const positionKey = (conditionId: string, asset: string): string =>
    `${conditionId}:${asset}`;

/** 跟单 BUY 成交后宽限期内不对「交易员镜像腿已平」做平仓，减轻 Data API 延迟误判 */
const reconcileTraderExitGraceUntilMs = new Map<string, number>();

const reconcileTraderExitGraceKey = (conditionId: string, asset: string): string =>
    positionKey(conditionId.toLowerCase(), normalizeClobAssetId(asset));

export const touchReconcileTraderExitGrace = (
    conditionId: string,
    asset: string,
    graceMs: number
): void => {
    if (!graceMs || graceMs <= 0) return;
    reconcileTraderExitGraceUntilMs.set(
        reconcileTraderExitGraceKey(conditionId, asset),
        Date.now() + graceMs
    );
};

export const isReconcileTraderExitInGrace = (conditionId: string, asset: string): boolean => {
    const k = reconcileTraderExitGraceKey(conditionId, asset);
    const until = reconcileTraderExitGraceUntilMs.get(k);
    if (until === undefined) return false;
    if (Date.now() >= until) {
        reconcileTraderExitGraceUntilMs.delete(k);
        return false;
    }
    return true;
};

/**
 * 同一 condition 上多个跟单交易员时的镜像腿模式：
 * 若同时存在正买与反买，降级为 FOLLOW（调用方应打日志）。
 */
export const copyModeForReconcileTraders = (
    traders: Set<string>
): { mode: CopyMode; mixedFollowAndReverse: boolean } => {
    let anyReverse = false;
    let anyFollow = false;
    for (const addr of traders) {
        const m = getCopyModeForTrader(addr);
        if (m === CopyMode.REVERSE) anyReverse = true;
        else anyFollow = true;
    }
    const mixed = anyReverse && anyFollow;
    const mode = mixed ? CopyMode.FOLLOW : anyReverse ? CopyMode.REVERSE : CopyMode.FOLLOW;
    return { mode, mixedFollowAndReverse: mixed };
};

/**
 * conditionId -> 在 Mongo 中有过 TRADE 且 bot 认领的跟单地址
 * （live / dry run 共用，避免平掉非跟单产生的仓位）
 */
export const loadCopiedConditionTraders = async (): Promise<Map<string, Set<string>>> => {
    const map = new Map<string, Set<string>>();
    for (const address of ENV.USER_ADDRESSES) {
        const Model = getUserActivityModel(address);
        const ids = await Model.distinct('conditionId', {
            type: 'TRADE',
            bot: true,
        });
        for (const cid of ids) {
            if (typeof cid !== 'string' || !cid) continue;
            if (!map.has(cid)) map.set(cid, new Set());
            map.get(cid)!.add(address);
        }
    }
    return map;
};

export const traderMirrorSize = (
    traderPositions: UserPositionInterface[],
    conditionId: string,
    mirrorAsset: string
): number => {
    const p = traderPositions.find(
        (pos) => pos.conditionId === conditionId && pos.asset === mirrorAsset
    );
    return p?.size ?? 0;
};

export const anyTraderStillInMirror = async (
    involved: Set<string>,
    conditionId: string,
    mirrorAsset: string,
    cache: Map<string, UserPositionInterface[]>
): Promise<boolean> => {
    for (const addr of involved) {
        let list = cache.get(addr);
        if (!list) {
            const raw = await fetchPositionsForUser(addr, { force: true });
            list = raw as UserPositionInterface[];
            cache.set(addr, list);
        }
        if (traderMirrorSize(list, conditionId, mirrorAsset) >= TRADER_MIRROR_MIN) {
            return true;
        }
    }
    return false;
};

/** curPrice 需为有效数字；NaN/无效时不因价格判定为已结算（避免无行情误平仓） */
export const isMarketResolved = (curPrice: number, redeemable: boolean): boolean => {
    if (redeemable === true) return true;
    if (!isFinite(curPrice)) return false;
    return curPrice >= RESOLVED_HIGH || curPrice <= RESOLVED_LOW;
};

/**
 * FOLLOW: 镜像资产即我方持仓 asset。
 * REVERSE: 镜像为交易员那一腿 = 我方 token 的 oppositeAsset。
 */
export const getMirrorAssetForReconcile = (
    copyMode: CopyMode,
    myAsset: string,
    oppositeAsset: string | undefined
): string | null => {
    if (copyMode === CopyMode.FOLLOW) {
        return myAsset;
    }
    if (!oppositeAsset || oppositeAsset === myAsset) {
        return null;
    }
    return oppositeAsset;
};
