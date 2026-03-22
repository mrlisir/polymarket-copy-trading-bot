#!/usr/bin/env ts-node
/**
 * 用 fetchData 拉 Gamma（clobTokenIds）+ CLOB /book，核对两腿 bids/asks 是否与网页一致。
 * 用法：npm run verify-clob-book [conditionId]
 * 默认：BitBoy convicted? 市场（流动性正常，便于对照 polymarket.com）
 */
import * as dotenv from 'dotenv';
dotenv.config();

import fetchData from '../utils/fetchData';
import { getConditionTokensMetaCached, resolveReverseAssetForCondition } from '../utils/conditionTokens';

const DEFAULT_CONDITION =
    '0xb48621f7eba07b0a3eeabc6afb09ae42490239903997b9d412b0f69aeb040c8b';

type BookSide = { price?: string; size?: string };
type BookResp = {
    bids?: BookSide[];
    asks?: BookSide[];
    sells?: BookSide[];
    last_trade_price?: string;
    asset_id?: string;
};

function lenSides(book: BookResp): { bids: number; asks: number } {
    const asks = book.asks ?? book.sells;
    return { bids: Array.isArray(book.bids) ? book.bids.length : 0, asks: Array.isArray(asks) ? asks.length : 0 };
}

async function main(): Promise<void> {
    const conditionId = (process.argv[2] || DEFAULT_CONDITION).trim();
    console.log('conditionId:', conditionId);

    const { tokenIds, outcomes } = await getConditionTokensMetaCached(conditionId);
    if (tokenIds.length < 2) {
        console.error('Gamma 未返回至少 2 个 clobTokenIds，请检查 conditionId 或网络。');
        process.exit(1);
    }

    console.log('outcomes:', outcomes.join(' | ') || '(无)');
    for (let i = 0; i < tokenIds.length; i++) {
        const tid = tokenIds[i];
        const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tid)}`;
        const book = (await fetchData(url)) as BookResp;
        const { bids, asks } = lenSides(book);
        const label = outcomes[i] || `leg${i}`;
        console.log(
            `[${i}] ${label} token=${tid.slice(0, 14)}... bids=${bids} asks=${asks} last=${book.last_trade_price ?? 'n/a'}`
        );
    }

    const leg0 = tokenIds[0];
    const rev = await resolveReverseAssetForCondition(conditionId, leg0);
    console.log(
        'resolveReverseAssetForCondition(leg0): valid=',
        rev.valid,
        'opposite=',
        rev.oppositeAsset ? `${rev.oppositeAsset.slice(0, 14)}...` : 'n/a'
    );

    if (rev.valid && rev.oppositeAsset && rev.oppositeAsset !== leg0) {
        console.log('OK: 反买对侧 token 与 Gamma 另一腿一致。');
    } else {
        console.warn('WARN: 对侧解析未通过，请检查 condition / Gamma 数据。');
        process.exit(2);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
