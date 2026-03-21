import { CopyMode } from '../config/copyStrategy';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';

export type CopyOutcomeLabels = {
    /** 交易员本笔所交易的 outcome 名称（对应 trade.asset） */
    traderOutcome: string;
    /** 我方实际持仓的结果方向（FOLLOW 与交易员相同；REVERSE 为相反腿） */
    myOutcome: string;
    /** 简短中文说明 */
    modeHint: string;
};

const invertKnownOutcome = (label: string): string | undefined => {
    const m = label.trim().toLowerCase();
    const map: Record<string, string> = {
        up: 'Down',
        down: 'Up',
        yes: 'No',
        no: 'Yes',
        true: 'False',
        false: 'True',
        long: 'Short',
        short: 'Long',
    };
    return map[m];
};

/**
 * 从交易员持仓行解析 outcome / oppositeOutcome（比 activity 更可靠）。
 * FOLLOW：我跟单同一 outcome。
 * REVERSE：我跟单 oppositeAsset 对应 oppositeOutcome（与交易员相反）。
 */
export function resolveCopyOutcomeLabels(
    copyMode: CopyMode,
    trade: Pick<UserActivityInterface, 'outcome' | 'asset' | 'conditionId' | 'oppositeAsset'>,
    traderPositions: UserPositionInterface[]
): CopyOutcomeLabels {
    const tp = traderPositions.find(
        (p) => p.conditionId === trade.conditionId && p.asset === trade.asset
    );

    const traderOutcome =
        (trade.outcome && String(trade.outcome).trim()) ||
        (tp?.outcome && String(tp.outcome).trim()) ||
        '未知';

    if (copyMode === CopyMode.FOLLOW) {
        return {
            traderOutcome,
            myOutcome: traderOutcome,
            modeHint: '跟随：与交易员同一结果方向',
        };
    }

    const oppositeLabel = (tp?.oppositeOutcome && String(tp.oppositeOutcome).trim()) || '';

    // 若 oppositeOutcome 缺失，尝试在同条件、交易员持有 opposite 腿时的 outcome 字段
    const oppLeg = trade.oppositeAsset
        ? traderPositions.find(
              (p) => p.conditionId === trade.conditionId && p.asset === trade.oppositeAsset
          )
        : undefined;
    const fromOppLeg = (oppLeg?.outcome && String(oppLeg.outcome).trim()) || '';

    const myOutcome =
        oppositeLabel ||
        fromOppLeg ||
        invertKnownOutcome(traderOutcome) ||
        '未知（positions 未返回 oppositeOutcome，反买以 oppositeAsset 为准）';

    return {
        traderOutcome,
        myOutcome,
        modeHint: '反买：与交易员相反结果方向',
    };
}
