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

let cachedTransporter: nodemailer.Transporter | null = null;

const isEnabled = (): boolean => {
    if (!ENV.EMAIL_NOTIFY_ENABLED) return false;
    if (!ENV.EMAIL_NOTIFY_TO) return false;
    if (!ENV.EMAIL_SMTP_USER || !ENV.EMAIL_SMTP_PASS) return false;
    return true;
};

const getTransporter = (): nodemailer.Transporter => {
    if (cachedTransporter) return cachedTransporter;
    cachedTransporter = nodemailer.createTransport({
        host: ENV.EMAIL_SMTP_HOST,
        port: ENV.EMAIL_SMTP_PORT,
        secure: ENV.EMAIL_SMTP_SECURE,
        auth: {
            user: ENV.EMAIL_SMTP_USER,
            pass: ENV.EMAIL_SMTP_PASS,
        },
    });
    return cachedTransporter;
};

const mask = (value?: string): string => {
    if (!value) return '-';
    if (value.length <= 12) return value;
    return `${value.slice(0, 10)}...${value.slice(-6)}`;
};

export const notifyOrderSuccess = async (params: NotifyParams): Promise<void> => {
    if (!isEnabled()) return;

    try {
        const transporter = getTransporter();
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

        await transporter.sendMail({
            from: ENV.EMAIL_FROM || ENV.EMAIL_SMTP_USER,
            to: ENV.EMAIL_NOTIFY_TO,
            subject,
            text: lines.join('\n'),
        });
    } catch (e) {
        Logger.warning(`[邮件通知] 发送失败: ${e instanceof Error ? e.message : String(e)}`);
    }
};

