import nodemailer from 'nodemailer';
import { ENV } from '../config/env';
import Logger from './logger';

type NotifyParams = {
    side: 'BUY' | 'SELL';
    amountUsd?: number;
    tokens?: number;
    price?: number;
    tokenId?: string;
    conditionId?: string;
    trader?: string;
    title?: string;
    txHash?: string;
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
        // Make failures return faster and more diagnosable.
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

export const notifyOrderSuccess = async (params: NotifyParams): Promise<void> => {
    if (!isEnabled()) return;
    if (!looksLikeEmail(ENV.EMAIL_SMTP_USER)) {
        Logger.warning(
            `[邮件通知] EMAIL_SMTP_USER 不是有效邮箱地址：${ENV.EMAIL_SMTP_USER || '-'}`
        );
        return;
    }

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const sideZh = params.side === 'BUY' ? '买入' : '卖出';
    const subject = `[Polymarket] ${sideZh}成功 - ${params.amountUsd?.toFixed(2) || '--'} USDC`;
    const lines = [
        `时间(北京时间): ${now}`,
        `方向: ${params.side}`,
        `金额(USDC): ${params.amountUsd?.toFixed(4) ?? '-'}`,
        `价格: ${params.price ?? '-'}`,
        `数量(tokens): ${params.tokens?.toFixed(4) ?? '-'}`,
        `市场: ${params.title || '-'}`,
        `交易员: ${mask(params.trader)}`,
        `tokenId: ${mask(params.tokenId)}`,
        `conditionId: ${mask(params.conditionId)}`,
        `txHash: ${params.txHash || '-'}`,
    ];

    const toList = ENV.EMAIL_NOTIFY_TO
        .split(',')
        .map((v) => v.trim())
        .filter((v) => looksLikeEmail(v));
    if (toList.length === 0) {
        Logger.warning('[邮件通知] EMAIL_NOTIFY_TO 未包含有效邮箱地址');
        return;
    }

    // QQ SMTP 对 MAIL FROM 参数较严格：优先使用 SMTP 登录邮箱作为 envelope.from。
    const headerFrom = looksLikeEmail(ENV.EMAIL_FROM) ? ENV.EMAIL_FROM : ENV.EMAIL_SMTP_USER;
    const mail = {
        from: headerFrom,
        to: toList.join(','),
        envelope: {
            from: ENV.EMAIL_SMTP_USER,
            to: toList,
        },
        subject,
        text: lines.join('\n'),
    };

    try {
        // First attempt: user-configured SMTP mode
        await createTransporter(ENV.EMAIL_SMTP_PORT, ENV.EMAIL_SMTP_SECURE).sendMail(mail);
    } catch (e) {
        const firstError = e instanceof Error ? e.message : String(e);

        // Auto fallback for common QQ SMTP handshake issues:
        // configured 465/secure=true fails -> retry with 587/secure=false (STARTTLS).
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
                    text: lines.join('\n'),
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

