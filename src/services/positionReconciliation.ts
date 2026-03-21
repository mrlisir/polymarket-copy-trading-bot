import { ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import { UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { fetchPositionsForUser } from '../utils/dataApiCache';
import Logger from '../utils/logger';
import { marketSellTokensFOK } from '../utils/postOrder';
import { redeemPolymarketCondition } from '../utils/ctfRedeem';
import {
    RECONCILE_MIN_SELL_TOKENS,
    anyTraderStillInMirror,
    getMirrorAssetForReconcile,
    isMarketResolved,
    loadCopiedConditionTraders,
    positionKey,
} from './positionReconciliationCore';

const lastReconcileActionAt = new Map<string, number>();

export interface PositionReconcileCallbacks {
    /** Optional: count sold notional toward daily volume (same as live fills). */
    onSoldUsd?: (usd: number) => void;
}

const clearBuyTrackingForAsset = async (conditionId: string, asset: string): Promise<void> => {
    for (const address of ENV.USER_ADDRESSES) {
        const Model = getUserActivityModel(address);
        await Model.updateMany(
            {
                conditionId,
                asset,
                side: 'BUY',
                bot: true,
                myBoughtSize: { $exists: true, $gt: 0 },
            },
            { $set: { myBoughtSize: 0 } }
        );
    }
};

const flattenLivePosition = async (
    clobClient: ClobClient,
    pos: UserPositionInterface,
    reason: string,
    callbacks?: PositionReconcileCallbacks
): Promise<{ initialTokens: number; soldTokens: number; proceedsUsd: number }> => {
    const initial = pos.size;
    if (initial < RECONCILE_MIN_SELL_TOKENS) {
        return { initialTokens: initial, soldTokens: 0, proceedsUsd: 0 };
    }

    Logger.header(`🧹 仓位对账平仓（实盘）`);
    Logger.info(`原因: ${reason}`);
    Logger.info(`市场: ${pos.title || pos.slug || pos.conditionId.slice(0, 16)}...`);
    Logger.info(`代币: ${pos.asset.slice(0, 14)}... | 数量: ${initial.toFixed(4)}`);

    const { proceedsUsd, soldTokens } = await marketSellTokensFOK(clobClient, pos.asset, initial);
    if (proceedsUsd > 0) {
        Logger.info(`✅ CLOB 卖出约 $${proceedsUsd.toFixed(2)}（${soldTokens.toFixed(4)} 代币）`);
        callbacks?.onSoldUsd?.(proceedsUsd);
    } else {
        Logger.warning('⚠️ CLOB 未成交或订单簿不可用（可稍后重试或检查 404）');
    }

    if (soldTokens >= initial * 0.95) {
        await clearBuyTrackingForAsset(pos.conditionId, pos.asset);
    }
    return { initialTokens: initial, soldTokens, proceedsUsd };
};

/**
 * 实盘周期性对账（npm start / npm run dev）：
 * 1) 已结算（curPrice ~0/1 或 redeemable）→ CLOB 卖出 + 可选链上赎回
 * 2) 跟单钱包镜像腿已平 → CLOB 卖出释放 USDC
 */
export const runPositionReconciliation = async (
    clobClient: ClobClient,
    callbacks?: PositionReconcileCallbacks
): Promise<void> => {
    const interval = ENV.POSITION_RECONCILE_INTERVAL_MS;
    if (!interval || interval <= 0) return;

    const maxPerRun = ENV.POSITION_RECONCILE_MAX_PER_RUN;
    const cooldownMs = ENV.POSITION_RECONCILE_COOLDOWN_MS;
    const onTraderExit = ENV.POSITION_RECONCILE_ON_TRADER_EXIT;
    const onResolved = ENV.POSITION_RECONCILE_ON_RESOLVED;
    const autoRedeem = ENV.POSITION_RECONCILE_AUTO_REDEEM;

    const copiedMap = await loadCopiedConditionTraders();
    if (copiedMap.size === 0) {
        return;
    }

    const rawMine = await fetchPositionsForUser(ENV.PROXY_WALLET);
    const myPositions = rawMine as UserPositionInterface[];

    const traderPosCache = new Map<string, UserPositionInterface[]>();
    const redeemedConditions = new Set<string>();
    let actions = 0;
    const now = Date.now();

    for (const pos of myPositions) {
        if (actions >= maxPerRun) break;
        if ((pos.size || 0) < RECONCILE_MIN_SELL_TOKENS) continue;

        const involved = copiedMap.get(pos.conditionId);
        if (!involved || involved.size === 0) continue;

        const pkey = positionKey(pos.conditionId, pos.asset);
        const lastAt = lastReconcileActionAt.get(pkey) || 0;
        if (now - lastAt < cooldownMs) continue;

        const copyMode = ENV.COPY_STRATEGY_CONFIG.copyMode;
        const mirrorAsset = getMirrorAssetForReconcile(
            copyMode,
            pos.asset,
            pos.oppositeAsset
        );

        if (!mirrorAsset) {
            Logger.warning(
                `[对账] 跳过 ${pkey}: 反买模式但缺少有效 oppositeAsset`
            );
            continue;
        }

        const cur =
            typeof pos.curPrice === 'number' && isFinite(pos.curPrice) ? pos.curPrice : Number.NaN;
        const resolvedByApi = pos.redeemable === true;
        const isResolved = isMarketResolved(cur, resolvedByApi);

        let handled = false;

        if (onResolved && isResolved) {
            const flattenResult = await flattenLivePosition(
                clobClient,
                pos,
                resolvedByApi
                    ? '市场已结算/可赎回 (API redeemable 或价格已贴近 0/1)'
                    : `市场结果已明朗 (curPrice=${isFinite(cur) ? cur.toFixed(4) : 'n/a'})`,
                callbacks
            );
            lastReconcileActionAt.set(pkey, Date.now());
            actions += 1;
            handled = true;

            const remainingTokens = Math.max(
                0,
                flattenResult.initialTokens - flattenResult.soldTokens
            );
            const clobNotFullyFilled =
                flattenResult.initialTokens > 0 &&
                flattenResult.soldTokens < flattenResult.initialTokens * 0.95;

            if (
                autoRedeem &&
                // API 明确可赎回，或 CLOB 在已结算路径下无法完全成交（常见于盘口过期/无流动性）
                (pos.redeemable === true || clobNotFullyFilled) &&
                !redeemedConditions.has(pos.conditionId)
            ) {
                redeemedConditions.add(pos.conditionId);
                Logger.info(
                    `[对账] 尝试链上赎回条件 ${pos.conditionId.slice(0, 14)}...（剩余约 ${remainingTokens.toFixed(4)} 代币）`
                );
                await redeemPolymarketCondition(pos.conditionId);
            }
        }

        if (handled) continue;

        if (onTraderExit) {
            const stillIn = await anyTraderStillInMirror(
                involved,
                pos.conditionId,
                mirrorAsset,
                traderPosCache
            );
            if (!stillIn) {
                await flattenLivePosition(
                    clobClient,
                    pos,
                    '跟单钱包在对应方向已无持仓（镜像腿已平）',
                    callbacks
                );
                lastReconcileActionAt.set(pkey, Date.now());
                actions += 1;
            }
        }
    }
};
