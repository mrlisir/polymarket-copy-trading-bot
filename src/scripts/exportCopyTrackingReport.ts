#!/usr/bin/env ts-node
/**
 * 从 Mongo `copy_tracking_*` 导出跟单回溯 Excel（成交流水 + 按交易员汇总 + 市场结算视角）。
 * 用法:
 *   npm run copy-tracking-export
 *   npm run copy-tracking-export -- --last-session
 *   npm run copy-tracking-export -- --session live_1234567890_ab12cd34
 *   npm run copy-tracking-export -- --days 14
 *
 * 输出目录: ENV.COPY_TRACKING_REPORT_DIR（默认 reports/）
 */
import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import connectDB, { closeDB } from '../config/db';
import { ENV } from '../config/env';
import { CopyTrackingEntryModel, CopyTrackingSessionModel } from '../models/copyTrackingJournal';
import { fetchGammaSettlementInfoCached } from '../utils/gammaSettlement';

type EntryDoc = {
    sessionId: string;
    runMode: string;
    createdAt: Date;
    traderAddress: string;
    traderDisplayName?: string;
    marketTitle?: string;
    slug?: string;
    conditionId?: string;
    copyMode: string;
    traderSide: string;
    mySide: string;
    traderOutcome?: string;
    myOutcome?: string;
    traderAsset?: string;
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

const winLoseFromPx = (px: number | undefined): string => {
    if (px === undefined || !Number.isFinite(px)) return '未知';
    if (px >= 0.995) return '赢(≈1)';
    if (px <= 0.005) return '输(≈0)';
    return '待定';
};

const parseArgs = (): { sessionId?: string; lastSession: boolean; days?: number } => {
    const argv = process.argv.slice(2);
    const lastSession = argv.includes('--last-session');
    let sessionId: string | undefined;
    let days: number | undefined;
    const si = argv.indexOf('--session');
    if (si >= 0 && argv[si + 1]) sessionId = argv[si + 1];
    const di = argv.indexOf('--days');
    if (di >= 0 && argv[di + 1]) {
        const n = parseInt(argv[di + 1], 10);
        if (Number.isFinite(n) && n > 0) days = n;
    }
    return { sessionId, lastSession, days };
};

async function resolveSessionId(opts: ReturnType<typeof parseArgs>): Promise<string | undefined> {
    if (opts.sessionId) return opts.sessionId;
    if (opts.lastSession) {
        const last = (await CopyTrackingSessionModel.findOne()
            .sort({ startedAt: -1 })
            .lean()
            .exec()) as { sessionId?: string } | null;
        return last?.sessionId;
    }
    return undefined;
}

async function main(): Promise<void> {
    if (!ENV.COPY_TRACKING_ENABLED) {
        console.warn('提示: COPY_TRACKING_ENABLED=false，历史数据可能为空；仍尝试导出。');
    }

    const opts = parseArgs();
    await connectDB();

    const sessionId = await resolveSessionId(opts);
    let entries: EntryDoc[];

    if (sessionId) {
        entries = (await CopyTrackingEntryModel.find({ sessionId })
            .sort({ createdAt: 1 })
            .lean()
            .exec()) as unknown as EntryDoc[];
        console.log(`会话: ${sessionId}，流水条数: ${entries.length}`);
    } else {
        const q: Record<string, unknown> = {};
        if (opts.days) {
            const since = new Date(Date.now() - opts.days * 86400000);
            q.createdAt = { $gte: since };
        }
        entries = (await CopyTrackingEntryModel.find(q)
            .sort({ createdAt: -1 })
            .limit(5000)
            .lean()
            .exec()) as unknown as EntryDoc[];
        console.log(
            `未指定 --session：导出${opts.days ? `最近 ${opts.days} 天` : '全部（最多5000条）'}，条数: ${entries.length}`
        );
    }

    if (entries.length === 0) {
        console.log('无数据可导出。请先运行 npm run dev / dryrun 并产生成交，或使用 --session / --days。');
        await closeDB();
        process.exit(0);
    }

    const conditionIds = [...new Set(entries.map((e) => e.conditionId).filter(Boolean))] as string[];
    const settlementMap = new Map<string, Awaited<ReturnType<typeof fetchGammaSettlementInfoCached>>>();
    for (const cid of conditionIds) {
        settlementMap.set(cid, await fetchGammaSettlementInfoCached(cid));
    }

    const outDir = path.resolve(process.cwd(), ENV.COPY_TRACKING_REPORT_DIR || 'reports');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outPath = path.join(outDir, `copy-tracking-${sessionId || 'export'}-${stamp}.xlsx`);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'polymarket-copy-trading-bot';
    wb.created = new Date();

    // ----- Sheet 1: 成交流水 -----
    const ws1 = wb.addWorksheet('成交流水', {
        views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws1.columns = [
        { header: '时间(UTC)', key: 't', width: 22 },
        { header: '运行模式', key: 'runMode', width: 10 },
        { header: '会话ID', key: 'sessionId', width: 28 },
        { header: '交易员地址', key: 'traderAddress', width: 18 },
        { header: '交易员显示名', key: 'traderDisplayName', width: 22 },
        { header: '市场标题', key: 'marketTitle', width: 40 },
        { header: '跟单模式', key: 'copyMode', width: 10 },
        { header: '交易员原方向', key: 'traderSide', width: 12 },
        { header: '我方成交方向', key: 'mySide', width: 12 },
        { header: '交易员Outcome', key: 'traderOutcome', width: 16 },
        { header: '我跟单Outcome', key: 'myOutcome', width: 16 },
        { header: 'USD金额', key: 'executedUsdc', width: 12 },
        { header: '代币变动', key: 'myTokenDelta', width: 12 },
        { header: '已实现盈亏(卖)', key: 'realizedPnlUsd', width: 14 },
        { header: 'conditionId', key: 'conditionId', width: 28 },
        { header: '市场状态', key: 'mktStatus', width: 10 },
        { header: '交易员token结算价', key: 'pxTrader', width: 16 },
        { header: '我跟单token结算价', key: 'pxMy', width: 18 },
        { header: '交易员侧结果', key: 'resTrader', width: 14 },
        { header: '我跟单侧结果', key: 'resMy', width: 14 },
        { header: '反买复盘说明', key: 'reverseNote', width: 36 },
        { header: 'txHash', key: 'traderTxHash', width: 22 },
        { header: '自动平仓类型', key: 'autoExitType', width: 16 },
        { header: '自动平仓原因', key: 'autoExitReason', width: 26 },
        { header: '自动平仓触发Pnl%', key: 'autoExitPercentPnl', width: 18 },
    ];

    for (const e of entries) {
        const info = e.conditionId ? settlementMap.get(e.conditionId) : undefined;
        let mktStatus = '未知';
        let pxTrader: number | undefined;
        let pxMy: number | undefined;
        if (info?.status === 'open') mktStatus = '进行中';
        else if (info?.status === 'not_found') mktStatus = '未查到';
        else if (info?.status === 'closed') {
            mktStatus = '已收盘';
            if (e.traderAsset) pxTrader = info.tokenToUsd.get(e.traderAsset);
            pxMy = info.tokenToUsd.get(e.myTradedAsset);
        }

        const resTrader = winLoseFromPx(pxTrader);
        const resMy = winLoseFromPx(pxMy);
        let reverseNote = '';
        if (e.copyMode === 'REVERSE') {
            reverseNote =
                '反买：持有对侧 token；二元市场下交易员侧「赢」通常对应我跟单侧「输」（以结算价列为准）。';
        } else {
            reverseNote = '正买：与交易员同向 token。';
        }

        ws1.addRow({
            t: e.createdAt instanceof Date ? e.createdAt.toISOString() : String(e.createdAt),
            runMode: e.runMode,
            sessionId: e.sessionId,
            traderAddress: e.traderAddress,
            traderDisplayName: e.traderDisplayName || '',
            marketTitle: e.marketTitle || '',
            copyMode: e.copyMode,
            traderSide: e.traderSide,
            mySide: e.mySide,
            traderOutcome: e.traderOutcome || '',
            myOutcome: e.myOutcome || '',
            executedUsdc: Number(e.executedUsdc.toFixed(4)),
            myTokenDelta: Number(e.myTokenDelta.toFixed(6)),
            realizedPnlUsd:
                e.realizedPnlUsd !== undefined && e.realizedPnlUsd !== null
                    ? Number(e.realizedPnlUsd.toFixed(4))
                    : '',
            conditionId: e.conditionId || '',
            mktStatus,
            pxTrader: pxTrader !== undefined ? Number(pxTrader.toFixed(4)) : '',
            pxMy: pxMy !== undefined ? Number(pxMy.toFixed(4)) : '',
            resTrader,
            resMy,
            reverseNote,
            traderTxHash: e.traderTxHash || '',
            autoExitType: e.autoExitType || '',
            autoExitReason: e.autoExitReason || '',
            autoExitPercentPnl:
                e.autoExitPercentPnl !== undefined && e.autoExitPercentPnl !== null
                    ? Number(e.autoExitPercentPnl.toFixed(2))
                    : '',
        });
    }
    ws1.getRow(1).font = { bold: true };

    // ----- Sheet 2: 按交易员汇总 -----
    const ws2 = wb.addWorksheet('按交易员汇总', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws2.columns = [
        { header: '交易员地址', key: 'addr', width: 20 },
        { header: '显示名', key: 'name', width: 22 },
        { header: '跟单模式', key: 'mode', width: 10 },
        { header: '买入成交笔数', key: 'nBuy', width: 14 },
        { header: '卖出成交笔数', key: 'nSell', width: 14 },
        { header: '买入总额USD', key: 'buyUsd', width: 14 },
        { header: '卖出回款USD', key: 'sellUsd', width: 14 },
        { header: '卖出已实现盈亏合计', key: 'realizedSum', width: 20 },
    ];

    const agg = new Map<
        string,
        {
            name: string;
            mode: string;
            nBuy: number;
            nSell: number;
            buyUsd: number;
            sellUsd: number;
            realizedSum: number;
        }
    >();

    for (const e of entries) {
        const k = e.traderAddress.toLowerCase();
        if (!agg.has(k)) {
            agg.set(k, {
                name: e.traderDisplayName || k,
                mode: e.copyMode,
                nBuy: 0,
                nSell: 0,
                buyUsd: 0,
                sellUsd: 0,
                realizedSum: 0,
            });
        }
        const a = agg.get(k)!;
        if (e.mySide === 'BUY') {
            a.nBuy += 1;
            a.buyUsd += e.executedUsdc;
        } else {
            a.nSell += 1;
            a.sellUsd += e.executedUsdc;
            if (e.realizedPnlUsd !== undefined && e.realizedPnlUsd !== null) {
                a.realizedSum += e.realizedPnlUsd;
            }
        }
    }

    for (const [addr, a] of agg) {
        ws2.addRow({
            addr,
            name: a.name,
            mode: a.mode,
            nBuy: a.nBuy,
            nSell: a.nSell,
            buyUsd: Number(a.buyUsd.toFixed(2)),
            sellUsd: Number(a.sellUsd.toFixed(2)),
            realizedSum: Number(a.realizedSum.toFixed(2)),
        });
    }
    ws2.getRow(1).font = { bold: true };

    // ----- Sheet 3: 市场维度（去重 condition + 交易员）-----
    const ws3 = wb.addWorksheet('市场结算视角', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws3.columns = [
        { header: '交易员', key: 'trader', width: 18 },
        { header: '显示名', key: 'name', width: 20 },
        { header: 'conditionId', key: 'cid', width: 28 },
        { header: '市场标题', key: 'title', width: 40 },
        { header: '跟单模式', key: 'mode', width: 10 },
        { header: '买入合计USD', key: 'buyUsd', width: 14 },
        { header: '卖出合计USD', key: 'sellUsd', width: 14 },
        { header: '市场状态', key: 'mkt', width: 10 },
        { header: '交易员token结算价', key: 'pxT', width: 16 },
        { header: '我跟单token结算价', key: 'pxM', width: 18 },
        { header: '交易员侧', key: 'rt', width: 12 },
        { header: '我跟单侧', key: 'rm', width: 12 },
        { header: '反买说明', key: 'note', width: 40 },
    ];

    type MKey = string;
    const markets = new Map<
        MKey,
        {
            trader: string;
            name: string;
            cid: string;
            title: string;
            mode: string;
            buyUsd: number;
            sellUsd: number;
            traderAsset?: string;
            myAsset?: string;
        }
    >();

    for (const e of entries) {
        if (!e.conditionId) continue;
        const key = `${e.traderAddress.toLowerCase()}::${e.conditionId}`;
        if (!markets.has(key)) {
            markets.set(key, {
                trader: e.traderAddress,
                name: e.traderDisplayName || '',
                cid: e.conditionId,
                title: e.marketTitle || '',
                mode: e.copyMode,
                buyUsd: 0,
                sellUsd: 0,
                traderAsset: e.traderAsset,
                myAsset: e.myTradedAsset,
            });
        }
        const m = markets.get(key)!;
        if (e.mySide === 'BUY') m.buyUsd += e.executedUsdc;
        else m.sellUsd += e.executedUsdc;
        if (e.traderAsset) m.traderAsset = e.traderAsset;
        if (e.mySide === 'BUY' && e.myTradedAsset) m.myAsset = e.myTradedAsset;
    }

    for (const m of markets.values()) {
        const info = settlementMap.get(m.cid);
        let mkt = '未知';
        let pxT: number | undefined;
        let pxM: number | undefined;
        if (info?.status === 'open') mkt = '进行中';
        else if (info?.status === 'not_found') mkt = '未查到';
        else if (info?.status === 'closed') {
            mkt = '已收盘';
            if (m.traderAsset) pxT = info.tokenToUsd.get(m.traderAsset);
            if (m.myAsset) pxM = info.tokenToUsd.get(m.myAsset);
        }
        const note =
            m.mode === 'REVERSE'
                ? '反买：复盘时以「我跟单token结算价」为准；与交易员侧通常相反（二元）。'
                : '正买：我跟单侧与交易员侧应对齐。';

        ws3.addRow({
            trader: m.trader,
            name: m.name,
            cid: m.cid,
            title: m.title,
            mode: m.mode,
            buyUsd: Number(m.buyUsd.toFixed(2)),
            sellUsd: Number(m.sellUsd.toFixed(2)),
            mkt,
            pxT: pxT !== undefined ? Number(pxT.toFixed(4)) : '',
            pxM: pxM !== undefined ? Number(pxM.toFixed(4)) : '',
            rt: winLoseFromPx(pxT),
            rm: winLoseFromPx(pxM),
            note,
        });
    }
    ws3.getRow(1).font = { bold: true };

    await wb.xlsx.writeFile(outPath);
    console.log(`已写入: ${outPath}`);
    await closeDB();
}

main().catch(async (e) => {
    console.error(e);
    try {
        await closeDB();
    } catch {
        // ignore
    }
    process.exit(1);
});
