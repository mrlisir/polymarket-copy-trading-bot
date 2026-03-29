import nodemailer from 'nodemailer';
import { ENV } from '../config/env';
import { CopyMode, copyModeEnvColumnHint } from '../config/copyStrategy';
import Logger from './logger';

export type NotifyParams = {
    side: 'BUY' | 'SELL';
    /** 为 true 时主题与正文标注为 Dry Run 模拟（与实盘成交通知区分） */
    dryRun?: boolean;
    amountUsd?: number;
    tokens?: number;
    price?: number;
    tokenId?: string;
    conditionId?: string;
    trader?: string;
    title?: string;
    txHash?: string;
    /** FOLLOW / REVERSE */
    copyMode?: 'FOLLOW' | 'REVERSE';
    /** 交易员本笔 outcome 文案 */
    traderOutcome?: string;
    /** 我方实际成交的结果方向 */
    myOutcome?: string;
    /** 模式说明（中文短句） */
    modeHint?: string;
    slug?: string;
    eventSlug?: string;
};

type PlainMail = {
    subject: string;
    text: string;
};

const looksLikeEmail = (value?: string): boolean => {
    if (!value) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
};

const isEnabled = (): boolean => {
    if (!ENV.EMAIL_NOTIFY_ENABLED) return false;
    if (!ENV.EMAIL_NOTIFY_TO) return false;
    if (!ENV.EMAIL_SMTP_USER || !ENV.EMAIL_SMTP_PASS) return false;
    return true;
};

const createTransporter = (port: number, secure: boolean): nodemailer.Transporter => {
    return nodemailer.createTransport({
        host: ENV.EMAIL_SMTP_HOST,
        port,
        secure,
        auth: {
            user: ENV.EMAIL_SMTP_USER,
            pass: ENV.EMAIL_SMTP_PASS,
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        tls: {
            servername: ENV.EMAIL_SMTP_HOST,
            minVersion: 'TLSv1.2',
        },
    });
};

const sendViaResend = async (mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
}): Promise<void> => {
    if (!ENV.RESEND_API_KEY) {
        throw new Error('RESEND_API_KEY 未配置');
    }
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${ENV.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: mail.from,
            to: mail.to.split(',').map((v) => v.trim()).filter(Boolean),
            subject: mail.subject,
            text: mail.text,
        }),
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Resend HTTP ${response.status}: ${body}`);
    }
};

const mask = (value?: string): string => {
    if (!value) return '-';
    if (value.length <= 12) return value;
    return `${value.slice(0, 10)}...${value.slice(-6)}`;
};

const fullOrMask = (value?: string, maxLen = 200): string => {
    if (!value) return '-';
    if (value.length <= maxLen) return value;
    return `${value.slice(0, 16)}...${value.slice(-8)}`;
};

/** Gamma：按 condition 查市场元数据（含 clobTokenIds） */
const linkGammaMarkets = (conditionId: string): string =>
    `https://gamma-api.polymarket.com/markets?condition_ids=${encodeURIComponent(conditionId)}`;

/** CLOB：该 token 的订单簿（成交价/深度） */
const linkClobBook = (tokenId: string): string =>
    `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`;

/** Polygon 链上交易回执 */
const linkPolygonTx = (txHash: string): string | null => {
    const h = String(txHash).trim();
    if (!h || h.startsWith('email-test')) return null;
    if (!/^0x[a-fA-F0-9]{64}$/.test(h)) return null;
    return `https://polygonscan.com/tx/${h}`;
};

/** Polymarket 前端（slug 因产品迭代可能变化，以实际打开为准） */
const linkPolymarketEvent = (eventSlug?: string, slug?: string): string | null => {
    const s = (eventSlug || slug || '').trim();
    if (!s) return null;
    return `https://polymarket.com/event/${encodeURIComponent(s)}`;
};

const parseValidToList = (): string[] =>
    ENV.EMAIL_NOTIFY_TO
        .split(',')
        .map((v) => v.trim())
        .filter((v) => looksLikeEmail(v));

const sendPlainEmail = async ({ subject, text }: PlainMail): Promise<void> => {
    const toList = parseValidToList();
    if (toList.length === 0) {
        Logger.warning('[邮件通知] EMAIL_NOTIFY_TO 未包含有效邮箱地址');
        return;
    }

    const headerFrom = looksLikeEmail(ENV.EMAIL_FROM) ? ENV.EMAIL_FROM : ENV.EMAIL_SMTP_USER;
    const mail = {
        from: headerFrom,
        to: toList.join(','),
        envelope: {
            from: ENV.EMAIL_SMTP_USER,
            to: toList,
        },
        subject,
        text,
    };

    try {
        await createTransporter(ENV.EMAIL_SMTP_PORT, ENV.EMAIL_SMTP_SECURE).sendMail(mail);
    } catch (e) {
        const firstError = e instanceof Error ? e.message : String(e);

        const shouldFallback = ENV.EMAIL_SMTP_SECURE && ENV.EMAIL_SMTP_PORT === 465;
        let smtpFallbackError = '';
        if (shouldFallback) {
            try {
                await createTransporter(587, false).sendMail(mail);
                Logger.info('[邮件通知] 465/TLS 失败，已自动切换 587/STARTTLS 发送成功');
                return;
            } catch (fallbackErr) {
                const secondError =
                    fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
                smtpFallbackError = secondError;
            }
        }

        const canUseHttpFallback =
            ENV.EMAIL_HTTP_FALLBACK_ENABLED &&
            (ENV.EMAIL_HTTP_PROVIDER === 'AUTO' || ENV.EMAIL_HTTP_PROVIDER === 'RESEND');

        if (canUseHttpFallback) {
            try {
                const httpFrom =
                    (looksLikeEmail(ENV.EMAIL_HTTP_FROM) && ENV.EMAIL_HTTP_FROM) || headerFrom;
                await sendViaResend({
                    from: httpFrom,
                    to: toList.join(','),
                    subject,
                    text,
                });
                Logger.info('[邮件通知] SMTP 失败，已通过 Resend HTTP 兜底发送成功');
                return;
            } catch (httpErr) {
                const httpError = httpErr instanceof Error ? httpErr.message : String(httpErr);
                Logger.warning(
                    `[邮件通知] 发送失败: SMTP=${firstError}${smtpFallbackError ? `; SMTP兜底=${smtpFallbackError}` : ''}; HTTP(Resend)=${httpError}`
                );
            }
        } else {
            Logger.warning(
                `[邮件通知] 发送失败: ${firstError}${smtpFallbackError ? `; SMTP兜底=${smtpFallbackError}` : ''}`
            );
        }

        Logger.info(
            `[邮件通知] 排查建议: EMAIL_SMTP_USER 必须是完整邮箱地址；QQ 邮箱授权码需开启 SMTP；可启用 EMAIL_HTTP_FALLBACK_ENABLED=true 并配置 RESEND_API_KEY 走 HTTP 兜底`
        );
    }
};

const buildOrderSuccessBody = (params: NotifyParams): string => {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const sideZh = params.side === 'BUY' ? '买入' : '卖出';
    const dryTag = params.dryRun ? '（Dry Run 模拟）' : '';
    const modeEnum = params.copyMode === 'REVERSE' ? CopyMode.REVERSE : CopyMode.FOLLOW;
    const envColumn = copyModeEnvColumnHint(modeEnum);
    const modeZh = params.copyMode === 'REVERSE' ? '反买 (REVERSE)' : '跟方向 (FOLLOW)';
    const notional =
        params.amountUsd != null && params.price != null
            ? `名义金额约 $${params.amountUsd.toFixed(4)} USDC（≈ 份额×成交价）`
            : `名义金额: $${params.amountUsd?.toFixed(4) ?? '-'} USDC`;

    const lines: string[] = [
        '══════════════════════════════════════════════════════════════',
        '',
        `【Polymarket 跟单成交通知】${sideZh} · ${modeZh}${dryTag}`,
        '',
        '──────────────── 摘要 ────────────────',
        `• 时间(北京时间): ${now}`,
        ...(params.dryRun ? ['• 运行模式: Dry Run 模拟（未发送真实链上/CLOB 订单）', ''] : []),
        `• 本笔订单方向: ${params.side}（${sideZh}）`,
        `• 跟单模式: ${modeZh}`,
        `• 对应 .env 配置列: ${envColumn}（该地址只应出现在此列）`,
        ...(params.side === 'SELL' && params.copyMode === 'REVERSE'
            ? [
                  `• 反买卖出: 本笔已同步执行我方卖出（oppositeAsset）；若仅需跟买不跟卖，可设 COPY_REVERSE_SYNC_TRADER_SELL=false。`,
              ]
            : []),
        ...(params.modeHint ? [`• 说明: ${params.modeHint}`] : []),
        `• 市场: ${params.title || '-'}`,
        `• 跟单交易员: ${mask(params.trader)}`,
        '',
        '──────────────── 方向与结果腿 ────────────────',
        `• 交易员本笔 outcome（Data/活动）: ${params.traderOutcome ?? '—'}`,
        `• 我方本笔成交结果方向: ${params.myOutcome ?? '—'}`,
        `• 说明: 「结果方向」指 Up/Down、Yes/No 等；反买模式下我方持有与交易员相反一侧的 outcome token。`,
        '',
        ...(Object.values(ENV.TRADER_COPY_MODE_BY_ADDRESS).some((m) => m === CopyMode.REVERSE) &&
        Object.values(ENV.TRADER_COPY_MODE_BY_ADDRESS).some((m) => m === CopyMode.FOLLOW)
            ? [
                  '• 提示: 当前为「正买 + 反买」混合跟单；不同交易员规则不同，请务必以本邮件中的「跟单模式」与「配置列」为准，勿与其它交易员成交混淆。',
                  '',
              ]
            : []),
        '──────────────── 成交明细 ────────────────',
        notional,
        `• 成交价格(概率价): ${params.price != null ? `$${Number(params.price).toFixed(4)}` : '-'}`,
        `• 成交数量(份额): ${params.tokens != null ? `${params.tokens.toFixed(4)} tokens` : '-'}`,
        '',
        '──────────────── 链上标识（用于核对） ────────────────',
        `• 我方成交 tokenId (CLOB outcome token):`,
        `  ${fullOrMask(params.tokenId, 120)}`,
        `• conditionId (条件 ID，同一市场二元条件共用一个):`,
        `  ${fullOrMask(params.conditionId, 120)}`,
        `• 关联链上交易哈希 txHash (Polygon):`,
        `  ${params.txHash || '-'}`,
        '',
        '──────────────── 快捷查询链接 ────────────────',
    ];

    if (params.conditionId) {
        lines.push(`• Gamma 市场元数据 API: ${linkGammaMarkets(params.conditionId)}`);
    }
    if (params.tokenId) {
        lines.push(`• CLOB 订单簿(本 token): ${linkClobBook(params.tokenId)}`);
    }
    const poly = params.txHash ? linkPolygonTx(params.txHash) : null;
    if (poly) {
        lines.push(`• Polygonscan 交易: ${poly}`);
    } else if (params.txHash) {
        lines.push(`• Polygonscan: （txHash 非标准 0x64 位格式，请手动在浏览器搜索）`);
    }
    const pm = linkPolymarketEvent(params.eventSlug, params.slug);
    if (pm) {
        lines.push(`• Polymarket 前端(事件页，slug 仅供参考): ${pm}`);
    }

    lines.push(
        '',
        '──────────────── 字段释义 ────────────────',
        '• tokenId: 某一侧结果（如 Up/Down）在 CLOB 上的唯一代币 ID，用于下单与盘口。',
        '• conditionId: 该二元市场/条件在链上的条件 ID；同一 condition 下通常有两个 tokenId。',
        '• txHash: 与交易员活动关联的 Polygon 交易哈希（若链上可查，可用 Polygonscan 打开）。',
        '',
        '══════════════════════════════════════════════════════════════',
        '',
        '本邮件由系统自动发送，请勿直接回复。',
        ''
    );

    return lines.join('\n');
};

/** 反买模式下因 COPY_REVERSE_SYNC_TRADER_SELL=false 未执行「交易员卖出→我方卖出」时的通知参数 */
export type ReverseSellSkipParams = {
    trader: string;
    title?: string;
    conditionId?: string;
    traderOutcome?: string;
    myOutcome?: string;
    modeHint?: string;
    slug?: string;
    eventSlug?: string;
    /** 我方本会卖出的 CLOB token（通常为 oppositeAsset） */
    myTradedTokenId?: string;
    txHash?: string;
    traderUsdcSize?: number;
    traderPrice?: number;
};

const buildReverseSellSkippedBody = (params: ReverseSellSkipParams): string => {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const envColumn = copyModeEnvColumnHint(CopyMode.REVERSE);
    const lines: string[] = [
        '══════════════════════════════════════════════════════════════',
        '',
        '【Polymarket 跟单】反买 · 未同步卖出（配置关闭）',
        '',
        '──────────────── 摘要 ────────────────',
        `• 时间(北京时间): ${now}`,
        `• 本笔处理: 已跳过执行「卖出」跟单（未向 CLOB 提交卖单）`,
        `• 跟单模式: 反买 (REVERSE)`,
        `• 对应 .env 配置列: ${envColumn}`,
        `• 控制项: COPY_REVERSE_SYNC_TRADER_SELL = false（为 true 时才会在交易员卖出时同步卖出我方 oppositeAsset 腿）`,
        ...(params.modeHint ? [`• 说明: ${params.modeHint}`] : []),
        `• 市场: ${params.title || '-'}`,
        `• 跟单交易员: ${mask(params.trader)}`,
        '',
        '──────────────── 交易员本笔（卖出）───────────────',
        `• 交易员订单名义(约): $${params.traderUsdcSize != null ? params.traderUsdcSize.toFixed(4) : '-'} USDC`,
        `• 交易员成交价(概率价): ${params.traderPrice != null ? `$${Number(params.traderPrice).toFixed(4)}` : '-'}`,
        '',
        '──────────────── 方向与结果腿（与成交通知一致）───────────────',
        `• 交易员本笔 outcome（Data/活动）: ${params.traderOutcome ?? '—'}`,
        `• 若已同步卖出，我方本会卖出的结果方向: ${params.myOutcome ?? '—'}`,
        `• 说明: 反买模式下我方持有与交易员相反一侧 outcome token；交易员卖 UP 时，同步卖出对应为我方卖 DOWN（以 tokenId / outcome 为准）。`,
        '',
        '──────────────── 链上标识（用于核对） ────────────────',
        `• 我方本会卖出的 tokenId (CLOB outcome token，未下单):`,
        `  ${fullOrMask(params.myTradedTokenId, 120)}`,
        `• conditionId (条件 ID):`,
        `  ${fullOrMask(params.conditionId, 120)}`,
        `• 关联交易员活动 txHash (Polygon):`,
        `  ${params.txHash || '-'}`,
        '',
        '──────────────── 快捷查询链接 ────────────────',
    ];

    if (params.conditionId) {
        lines.push(`• Gamma 市场元数据 API: ${linkGammaMarkets(params.conditionId)}`);
    }
    if (params.myTradedTokenId) {
        lines.push(`• CLOB 订单簿(本会卖出的 token): ${linkClobBook(params.myTradedTokenId)}`);
    }
    const poly = params.txHash ? linkPolygonTx(params.txHash) : null;
    if (poly) {
        lines.push(`• Polygonscan 交易: ${poly}`);
    } else if (params.txHash) {
        lines.push(`• Polygonscan: （txHash 非标准 0x64 位格式，请手动在浏览器搜索）`);
    }
    const pm = linkPolymarketEvent(params.eventSlug, params.slug);
    if (pm) {
        lines.push(`• Polymarket 前端(事件页): ${pm}`);
    }

    lines.push(
        '',
        '──────────────── 说明 ────────────────',
        '• 本邮件在「反买 + 交易员卖出」且 COPY_REVERSE_SYNC_TRADER_SELL=false 时发送；与「卖出成交通知」互斥（未成交故无成交邮件）。',
        '• 若需恢复同步卖出，请将 .env 中 COPY_REVERSE_SYNC_TRADER_SELL 设为 true 并重启进程。',
        '',
        '══════════════════════════════════════════════════════════════',
        '',
        '本邮件由系统自动发送，请勿直接回复。',
        ''
    );

    return lines.join('\n');
};

export const notifyReverseTraderSellSkipped = async (params: ReverseSellSkipParams): Promise<void> => {
    if (!isEnabled()) return;
    if (!looksLikeEmail(ENV.EMAIL_SMTP_USER)) {
        Logger.warning(
            `[邮件通知] EMAIL_SMTP_USER 不是有效邮箱地址：${ENV.EMAIL_SMTP_USER || '-'}`
        );
        return;
    }

    const subject = `[Polymarket] 反买·未同步卖出（COPY_REVERSE_SYNC_TRADER_SELL=false）· ${params.title || 'market'}`;
    const text = buildReverseSellSkippedBody(params);

    await sendPlainEmail({ subject, text });
};

export const notifyOrderSuccess = async (params: NotifyParams): Promise<void> => {
    if (!isEnabled()) return;
    if (!looksLikeEmail(ENV.EMAIL_SMTP_USER)) {
        Logger.warning(
            `[邮件通知] EMAIL_SMTP_USER 不是有效邮箱地址：${ENV.EMAIL_SMTP_USER || '-'}`
        );
        return;
    }

    const sideZh = params.side === 'BUY' ? '买入' : '卖出';
    const modeShort = params.copyMode === 'REVERSE' ? '反买' : '跟单';
    const dryPrefix = params.dryRun ? 'Dry Run·' : '';
    const subject = `[Polymarket] ${dryPrefix}${sideZh}成交通知 · ${modeShort} · $${params.amountUsd?.toFixed(2) ?? '--'} USDC`;
    const text = buildOrderSuccessBody(params);

    await sendPlainEmail({ subject, text });
};

export const notifyCopyRiskStop = async (params: {
    trader: string;
    reason: string;
    consecutiveLosses: number;
    cumulativeLossUsd: number;
    mode: 'LIVE' | 'DRYRUN';
    copyMode?: 'FOLLOW' | 'REVERSE';
    /** 中文一行，含 .env 列名 */
    copyModeDetailZh?: string;
}): Promise<void> => {
    if (!isEnabled()) return;
    if (!looksLikeEmail(ENV.EMAIL_SMTP_USER)) return;

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const subject = `[Polymarket] 跟单熔断 · 已停止跟踪 ${mask(params.trader)}`;
    const text = [
        '══════════════════════════════════════════════════════════════',
        '',
        '【Polymarket 跟单风险熔断】',
        '',
        `• 时间(北京时间): ${now}`,
        `• 运行模式: ${params.mode === 'LIVE' ? '实盘' : 'Dry Run 模拟'}`,
        `• 交易员地址: ${mask(params.trader)}`,
        `• 跟单配置: ${params.copyModeDetailZh ?? (params.copyMode === 'REVERSE' ? '反买 (REVERSE) · USER_ADDRESSES_REVERSE' : '跟方向 (FOLLOW) · USER_ADDRESSES_FOLLOW')}`,
        `• 停止原因: ${params.reason}`,
        `• 连续亏损次数: ${params.consecutiveLosses}`,
        `• 累计亏损(USD): ${params.cumulativeLossUsd.toFixed(2)}`,
        '',
        '说明: 熔断后本进程内将不再执行该交易员的新跟单；重启后计数会重置（除非后续增加持久化黑名单）。',
        '',
        '══════════════════════════════════════════════════════════════',
        '',
        '本邮件由系统自动发送，请勿直接回复。',
        '',
    ].join('\n');

    await sendPlainEmail({ subject, text });
};

export type AutoProfitExitMailKind = 'TAKE_PROFIT' | 'STOP_LOSS';

export type NotifyAutoProfitExitParams = {
    runMode: 'LIVE' | 'DRYRUN';
    kind: AutoProfitExitMailKind;
    marketTitle: string;
    conditionId: string;
    tokenId: string;
    soldTokens: number;
    proceedsUsd: number;
    plannedSize: number;
    remainingTokens: number;
    exitFull: boolean;
    realizedPnlUsd?: number;
    percentPnlAtTrigger?: number;
    triggerReason: string;
    copyMode?: 'FOLLOW' | 'REVERSE';
    traderMask?: string;
};

export const notifyAutoProfitExit = async (p: NotifyAutoProfitExitParams): Promise<void> => {
    if (!isEnabled()) return;
    if (!looksLikeEmail(ENV.EMAIL_SMTP_USER)) return;

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const kindZh = p.kind === 'TAKE_PROFIT' ? '止盈' : '止损';
    const modeZh = p.runMode === 'LIVE' ? '实盘' : 'Dry Run 模拟';
    const exitZh = p.exitFull ? '已基本全平' : '部分成交（后续可能继续重试）';
    const modeEnum = p.copyMode === 'REVERSE' ? CopyMode.REVERSE : CopyMode.FOLLOW;
    const envCol = copyModeEnvColumnHint(modeEnum);
    const modeLine =
        p.copyMode === 'REVERSE'
            ? '反买 (REVERSE)'
            : p.copyMode === 'FOLLOW'
              ? '跟方向 (FOLLOW)'
              : '—';

    const subject = `[Polymarket] 自动${kindZh}·${modeZh}·${(p.marketTitle || 'market').slice(0, 48)}`;
    const lines: string[] = [
        '══════════════════════════════════════════════════════════════',
        '',
        `【Polymarket 自动${kindZh}（AUTO EXIT）】`,
        '',
        `• 时间(北京时间): ${now}`,
        `• 运行模式: ${modeZh}`,
        `• 类型: ${kindZh}（${p.kind}）`,
        `• 平仓结果: ${exitZh}`,
        `• 触发原因: ${p.triggerReason}`,
        `• 市场: ${p.marketTitle || '-'}`,
        `• 计划卖出份额: ${p.plannedSize.toFixed(4)} tokens`,
        `• 实际卖出份额: ${p.soldTokens.toFixed(4)} tokens`,
        `• 剩余份额(约): ${p.remainingTokens.toFixed(4)} tokens`,
        `• 回收 USDC(约): $${p.proceedsUsd.toFixed(4)}`,
        ...(p.percentPnlAtTrigger != null && Number.isFinite(p.percentPnlAtTrigger)
            ? [`• 触发时 ROI(约): ${p.percentPnlAtTrigger.toFixed(2)}%`]
            : []),
        ...(p.realizedPnlUsd != null && Number.isFinite(p.realizedPnlUsd)
            ? [`• 本次已实现盈亏(估算): $${p.realizedPnlUsd.toFixed(4)}`]
            : []),
        ...(p.copyMode
            ? [`• 跟单模式: ${modeLine}`, `• 对应 .env 列: ${envCol}`]
            : []),
        ...(p.traderMask ? [`• 关联交易员: ${p.traderMask}`] : []),
        '',
        '──────────────── 链上标识 ────────────────',
        `• tokenId: ${fullOrMask(p.tokenId, 120)}`,
        `• conditionId: ${fullOrMask(p.conditionId, 120)}`,
        '',
        '──────────────── 快捷链接 ────────────────',
    ];
    if (p.conditionId) {
        lines.push(`• Gamma: ${linkGammaMarkets(p.conditionId)}`);
    }
    if (p.tokenId) {
        lines.push(`• CLOB 订单簿: ${linkClobBook(p.tokenId)}`);
    }
    lines.push(
        '',
        '说明: 本邮件在自动止盈/止损尝试卖出后发送；全平时已清理 Mongo tracked BUY。',
        '',
        '══════════════════════════════════════════════════════════════',
        '',
        '本邮件由系统自动发送，请勿直接回复。',
        ''
    );

    await sendPlainEmail({ subject, text: lines.join('\n') });
};

export type PositionClearReasonCode =
    | 'COPY_SELL_TRACKED_CLEARED'
    | 'AUTO_EXIT_MANUAL_FLAT_MS'
    | 'AUTO_EXIT_DUST_SIZE'
    | 'AUTO_EXIT_REDEEMABLE_NO_BID'
    | 'AUTO_EXIT_WATCH_STOP_NO_TRACKED'
    | 'RECONCILE_FLATTEN'
    | 'RECONCILE_NO_LIQUIDITY_CLEAR'
    | 'DRYRUN_AUTO_EXIT_FLAT'
    | 'DRYRUN_AUTO_EXIT_DUST';

export type NotifyPositionClearParams = {
    runMode: 'LIVE' | 'DRYRUN';
    reasonCode: PositionClearReasonCode;
    marketTitle?: string;
    conditionId?: string;
    tokenId?: string;
    /** 人类可读说明（可含数据） */
    detailZh: string;
    soldTokens?: number;
    proceedsUsd?: number;
};

const reasonCodeTitle = (code: PositionClearReasonCode): string => {
    const map: Record<PositionClearReasonCode, string> = {
        COPY_SELL_TRACKED_CLEARED: '跟单卖出·追踪已清仓',
        AUTO_EXIT_MANUAL_FLAT_MS: 'AUTO EXIT·手动卖光后停监控',
        AUTO_EXIT_DUST_SIZE: 'AUTO EXIT·碎仓清理',
        AUTO_EXIT_REDEEMABLE_NO_BID: 'AUTO EXIT·可赎回/无买盘停跟踪',
        AUTO_EXIT_WATCH_STOP_NO_TRACKED: 'AUTO EXIT·无持仓且 tracked 已空',
        RECONCILE_FLATTEN: '仓位对账·平仓',
        RECONCILE_NO_LIQUIDITY_CLEAR: '对账·无流动性·清 tracked',
        DRYRUN_AUTO_EXIT_FLAT: 'Dry Run·模拟仓清空停监控',
        DRYRUN_AUTO_EXIT_DUST: 'Dry Run·碎仓清理',
    };
    return map[code] || code;
};

export const notifyPositionClear = async (p: NotifyPositionClearParams): Promise<void> => {
    if (!isEnabled()) return;
    if (!looksLikeEmail(ENV.EMAIL_SMTP_USER)) return;

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const modeZh = p.runMode === 'LIVE' ? '实盘' : 'Dry Run 模拟';
    const title = reasonCodeTitle(p.reasonCode);
    const subject = `[Polymarket] 清仓/停跟踪·${title}·${modeZh}`;

    const lines: string[] = [
        '══════════════════════════════════════════════════════════════',
        '',
        '【Polymarket 持仓追踪清理 / 停跟踪通知】',
        '',
        `• 时间(北京时间): ${now}`,
        `• 运行模式: ${modeZh}`,
        `• 场景: ${title}`,
        `• 说明: ${p.detailZh}`,
        `• 市场: ${p.marketTitle || '-'}`,
        ...(p.soldTokens != null && Number.isFinite(p.soldTokens)
            ? [`• 涉及卖出份额(如有): ${p.soldTokens.toFixed(4)} tokens`]
            : []),
        ...(p.proceedsUsd != null && Number.isFinite(p.proceedsUsd)
            ? [`• 涉及回收 USDC(如有): $${p.proceedsUsd.toFixed(4)}`]
            : []),
        '',
        '──────────────── 链上标识 ────────────────',
        `• conditionId: ${p.conditionId ? fullOrMask(p.conditionId, 120) : '-'}`,
        `• tokenId: ${p.tokenId ? fullOrMask(p.tokenId, 120) : '-'}`,
        '',
    ];
    if (p.conditionId) {
        lines.push(`• Gamma: ${linkGammaMarkets(p.conditionId)}`);
    }
    if (p.tokenId) {
        lines.push(`• CLOB 订单簿: ${linkClobBook(p.tokenId)}`);
    }
    lines.push(
        '',
        '══════════════════════════════════════════════════════════════',
        '',
        '本邮件由系统自动发送，请勿直接回复。',
        ''
    );

    await sendPlainEmail({ subject, text: lines.join('\n') });
};

export type MartingaleOrderNotifyContext = {
    seriesKey: string;
    execMode: 'live' | 'dryrun';
    sideLabel: string;
    stakeUsd: number;
    entryPrice: number;
    shares: number;
    slug: string;
    question: string;
    conditionId: string;
    tokenId: string;
    stepTierZh: string;
    sessionRealizedPnlUsd: number;
    theoryWindowUtc: string;
};

export type MartingaleSettleNotifyContext = {
    seriesKey: string;
    execMode: 'live' | 'dryrun';
    sideLabel: string;
    winningOutcome: string;
    won: boolean;
    pnlRoundUsd: number;
    sessionRealizedPnlUsd: number;
    entryPrice: number;
    slug: string;
    question: string;
    theoryWindowUtc: string;
    stepAfter: number;
    maxSteps: number;
    nextStakeZh: string;
    usedForceSettle: boolean;
    usedBookSettle: boolean;
};

const buildMartingaleOrderBody = (p: MartingaleOrderNotifyContext): string => {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const modeZh = p.execMode === 'live' ? '实盘' : 'Dry Run 模拟（无链上成交）';
    const pm = linkPolymarketEvent(undefined, p.slug);
    const lines: string[] = [
        '══════════════════════════════════════════════════════════════',
        '',
        '【Polymarket 马丁格尔 · 下单通知】',
        '',
        `• 时间(北京时间): ${now}`,
        `• 运行模式: ${modeZh}`,
        `• 序列: ${p.seriesKey}`,
        `• 本笔押边: ${p.sideLabel}`,
        `• 名义/花费: $${p.stakeUsd.toFixed(4)} USDC`,
        `• 入场价(概率价): ${p.entryPrice.toFixed(4)}`,
        `• 份额(约): ${p.shares.toFixed(4)}`,
        `• 档位说明: ${p.stepTierZh}`,
        `• 会话累计已实现(不含本笔浮动): ${p.sessionRealizedPnlUsd >= 0 ? '+' : ''}${p.sessionRealizedPnlUsd.toFixed(2)} USD`,
        `• 理论窗(UTC): ${p.theoryWindowUtc}`,
        `• 题目: ${p.question || '-'}`,
        `• slug: ${p.slug}`,
        '',
        '──────────────── 链上标识 ────────────────',
        `• conditionId: ${p.conditionId ? fullOrMask(p.conditionId, 120) : '-'}`,
        `• tokenId: ${p.tokenId ? fullOrMask(p.tokenId, 120) : '-'}`,
        '',
        '──────────────── 链接 ────────────────',
    ];
    if (p.conditionId) {
        lines.push(`• Gamma: ${linkGammaMarkets(p.conditionId)}`);
    }
    if (p.tokenId) {
        lines.push(`• CLOB 订单簿: ${linkClobBook(p.tokenId)}`);
    }
    if (pm) {
        lines.push(`• Polymarket: ${pm}`);
    }
    lines.push(
        '',
        '说明: 请在根 `.env` 配置 EMAIL_* SMTP；马丁开关为 MARTINGALE_EMAIL_ON_ORDER。',
        '',
        '══════════════════════════════════════════════════════════════',
        '',
        '本邮件由系统自动发送，请勿直接回复。',
        ''
    );
    return lines.join('\n');
};

const buildMartingaleSettleBody = (p: MartingaleSettleNotifyContext): string => {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const modeZh = p.execMode === 'live' ? '实盘' : 'Dry Run 模拟';
    const pm = linkPolymarketEvent(undefined, p.slug);
    const pnlSign = p.pnlRoundUsd >= 0 ? '+' : '';
    const lines: string[] = [
        '══════════════════════════════════════════════════════════════',
        '',
        '【Polymarket 马丁格尔 · 收盘结算】',
        '',
        `• 时间(北京时间): ${now}`,
        `• 运行模式: ${modeZh}`,
        `• 序列: ${p.seriesKey}`,
        ...(p.usedBookSettle
            ? [
                  '• ⚠ 本笔为「CLOB 两侧价谁高谁赢」快速推断结算，可能与官方 closed 不一致。',
              ]
            : []),
        ...(p.usedForceSettle && !p.usedBookSettle
            ? [
                  '• ⚠ 本笔为 Gamma 滞后下的「逾期推断」结算，请以链上/官方结果为准。',
              ]
            : []),
        `• 曾押边: ${p.sideLabel} | 胜出结果: ${p.winningOutcome}`,
        `• 本局盈亏: ${pnlSign}${p.pnlRoundUsd.toFixed(2)} USD（${p.won ? '赢' : '输'}）`,
        `• 会话累计已实现: ${p.sessionRealizedPnlUsd >= 0 ? '+' : ''}${p.sessionRealizedPnlUsd.toFixed(2)} USD`,
        `• 参考入场价: ${p.entryPrice.toFixed(4)}`,
        `• 理论窗(UTC): ${p.theoryWindowUtc}`,
        `• 下一档: ${p.stepAfter + 1}/${p.maxSteps}（内部 stepIndex=${p.stepAfter}）`,
        `• 下一笔名义策略: ${p.nextStakeZh}`,
        `• 题目: ${p.question || '-'}`,
        `• slug: ${p.slug}`,
        '',
        '──────────────── 链接 ────────────────',
    ];
    if (pm) {
        lines.push(`• Polymarket: ${pm}`);
    }
    lines.push(
        '',
        '说明: 马丁开关为 MARTINGALE_EMAIL_ON_SETTLE；SMTP 与跟单共用。',
        '',
        '══════════════════════════════════════════════════════════════',
        '',
        '本邮件由系统自动发送，请勿直接回复。',
        ''
    );
    return lines.join('\n');
};

/** 马丁格尔：下单/挂单成功后发信（受 MARTINGALE_EMAIL_ON_ORDER 与全局 EMAIL_NOTIFY_* 控制） */
export const notifyMartingaleOrderFilled = async (
    p: MartingaleOrderNotifyContext,
    martingaleMailEnabled: boolean
): Promise<void> => {
    if (!martingaleMailEnabled || !isEnabled()) {
        return;
    }
    if (!looksLikeEmail(ENV.EMAIL_SMTP_USER)) {
        Logger.warning(
            `[邮件通知·马丁] EMAIL_SMTP_USER 不是有效邮箱地址：${ENV.EMAIL_SMTP_USER || '-'}`
        );
        return;
    }
    const dryPrefix = p.execMode === 'dryrun' ? 'Dry·' : '';
    const subject = `[Polymarket·马丁] ${dryPrefix}已下单 ${p.seriesKey} ${p.sideLabel} $${p.stakeUsd.toFixed(2)}`;
    await sendPlainEmail({ subject, text: buildMartingaleOrderBody(p) });
};

/** 马丁格尔：窗口结算后发信（受 MARTINGALE_EMAIL_ON_SETTLE 与全局 EMAIL_NOTIFY_* 控制） */
export const notifyMartingaleSettled = async (
    p: MartingaleSettleNotifyContext,
    martingaleMailEnabled: boolean
): Promise<void> => {
    if (!martingaleMailEnabled || !isEnabled()) {
        return;
    }
    if (!looksLikeEmail(ENV.EMAIL_SMTP_USER)) {
        return;
    }
    const w = p.won ? '赢' : '输';
    const dryPrefix = p.execMode === 'dryrun' ? 'Dry·' : '';
    const subject = `[Polymarket·马丁] ${dryPrefix}已收盘${w} ${p.seriesKey} ${p.pnlRoundUsd >= 0 ? '+' : ''}${p.pnlRoundUsd.toFixed(2)}U`;
    await sendPlainEmail({ subject, text: buildMartingaleSettleBody(p) });
};
