import nodemailer from 'nodemailer';
import { ENV } from '../config/env';
import { CopyMode, copyModeEnvColumnHint } from '../config/copyStrategy';
import Logger from './logger';

export type NotifyParams = {
    side: 'BUY' | 'SELL';
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
        `【Polymarket 跟单成交通知】${sideZh} · ${modeZh}`,
        '',
        '──────────────── 摘要 ────────────────',
        `• 时间(北京时间): ${now}`,
        `• 本笔订单方向: ${params.side}（${sideZh}）`,
        `• 跟单模式: ${modeZh}`,
        `• 对应 .env 配置列: ${envColumn}（该地址只应出现在此列）`,
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
    const subject = `[Polymarket] ${sideZh}成交通知 · ${modeShort} · $${params.amountUsd?.toFixed(2) ?? '--'} USDC`;
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
