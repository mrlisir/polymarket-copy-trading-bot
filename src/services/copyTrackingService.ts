import { randomUUID } from 'crypto';
import { ENV } from '../config/env';
import { CopyMode } from '../config/copyStrategy';
import { CopyTrackingEntryModel, CopyTrackingSessionModel } from '../models/copyTrackingJournal';

let activeSessionId: string | null = null;

export const getActiveCopySessionId = (): string | null => activeSessionId;

export function formatTraderDisplayName(
    trade: { pseudonym?: string; name?: string },
    address: string
): string {
    const parts = [trade.pseudonym, trade.name].filter((x) => x && String(x).trim());
    if (parts.length) {
        return parts.map((x) => String(x).trim()).join(' / ');
    }
    if (address && address.length >= 12) {
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }
    return address || '';
}

/**
 * 启动跟单进程时创建会话（实盘 / 模拟各一条）；用于回溯报表按「本次运行」筛选。
 */
export async function startCopyTrackingSession(runMode: 'live' | 'dryrun'): Promise<string | null> {
    if (!ENV.COPY_TRACKING_ENABLED) {
        return null;
    }
    try {
        const sessionId = `${runMode}_${Date.now()}_${randomUUID().slice(0, 8)}`;
        await CopyTrackingSessionModel.create({
            sessionId,
            runMode,
            startedAt: new Date(),
            proxyWallet: ENV.PROXY_WALLET,
            traderAddresses: [...ENV.USER_ADDRESSES],
        });
        activeSessionId = sessionId;
        return sessionId;
    } catch (e) {
        console.warn('[copyTracking] 创建会话失败:', e);
        return null;
    }
}

export async function endCopyTrackingSession(): Promise<void> {
    if (!activeSessionId) {
        return;
    }
    const sid = activeSessionId;
    activeSessionId = null;
    try {
        await CopyTrackingSessionModel.updateOne({ sessionId: sid }, { $set: { endedAt: new Date() } }).exec();
    } catch (e) {
        console.warn('[copyTracking] 结束会话失败:', e);
    }
}

export type RecordCopyTrackingFillParams = {
    runMode: 'live' | 'dryrun';
    traderAddress: string;
    traderDisplayName: string;
    marketTitle: string;
    slug?: string;
    conditionId?: string;
    copyMode: CopyMode;
    traderSide: 'BUY' | 'SELL';
    mySide: 'BUY' | 'SELL';
    traderOutcome?: string;
    myOutcome?: string;
    traderAsset: string;
    myTradedAsset: string;
    executedUsdc: number;
    myTokenDelta: number;
    traderTxHash?: string;
    activityObjectId?: string;
    realizedPnlUsd?: number;
    autoExitType?: string;
    autoExitReason?: string;
    autoExitPercentPnl?: number;
};

/** 成交后写入流水（无活跃会话时静默跳过） */
export async function recordCopyTrackingFill(p: RecordCopyTrackingFillParams): Promise<void> {
    if (!ENV.COPY_TRACKING_ENABLED || !activeSessionId) {
        return;
    }
    try {
        await CopyTrackingEntryModel.create({
            sessionId: activeSessionId,
            runMode: p.runMode,
            traderAddress: p.traderAddress.toLowerCase(),
            traderDisplayName: p.traderDisplayName,
            marketTitle: p.marketTitle || '',
            slug: p.slug,
            conditionId: p.conditionId || '',
            copyMode: p.copyMode === CopyMode.REVERSE ? 'REVERSE' : 'FOLLOW',
            traderSide: p.traderSide,
            mySide: p.mySide,
            traderOutcome: p.traderOutcome,
            myOutcome: p.myOutcome,
            traderAsset: p.traderAsset,
            myTradedAsset: p.myTradedAsset,
            executedUsdc: p.executedUsdc,
            myTokenDelta: p.myTokenDelta,
            traderTxHash: p.traderTxHash,
            activityObjectId: p.activityObjectId,
            realizedPnlUsd: p.realizedPnlUsd,
            autoExitType: p.autoExitType,
            autoExitReason: p.autoExitReason,
            autoExitPercentPnl: p.autoExitPercentPnl,
        });
    } catch (e) {
        console.warn('[copyTracking] 写入成交流水失败:', e);
    }
}
