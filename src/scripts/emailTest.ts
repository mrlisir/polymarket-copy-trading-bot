#!/usr/bin/env ts-node

import { ENV } from '../config/env';
import { notifyOrderSuccess } from '../utils/emailNotifier';

const looksLikeEmail = (value?: string): boolean => {
    if (!value) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
};

const run = async () => {
    console.log('\n📧 邮件通知测试');
    console.log('──────────────────────────────────────────────────────────────────────');

    if (!ENV.EMAIL_NOTIFY_ENABLED) {
        console.error('❌ EMAIL_NOTIFY_ENABLED=false，邮件通知未启用');
        console.error("请在 .env 中设置: EMAIL_NOTIFY_ENABLED='true'");
        process.exit(1);
    }

    if (!ENV.EMAIL_NOTIFY_TO) {
        console.error('❌ EMAIL_NOTIFY_TO 未配置');
        process.exit(1);
    }

    if (!ENV.EMAIL_SMTP_USER || !ENV.EMAIL_SMTP_PASS) {
        console.error('❌ EMAIL_SMTP_USER / EMAIL_SMTP_PASS 未完整配置');
        process.exit(1);
    }
    if (!looksLikeEmail(ENV.EMAIL_SMTP_USER)) {
        console.error(`❌ EMAIL_SMTP_USER 不是有效邮箱地址: ${ENV.EMAIL_SMTP_USER}`);
        process.exit(1);
    }

    console.log(`SMTP: ${ENV.EMAIL_SMTP_HOST}:${ENV.EMAIL_SMTP_PORT} (secure=${ENV.EMAIL_SMTP_SECURE})`);
    console.log(`发件人: ${ENV.EMAIL_FROM || ENV.EMAIL_SMTP_USER}`);
    console.log(`收件人: ${ENV.EMAIL_NOTIFY_TO}`);
    console.log('正在发送测试邮件...\n');

    await notifyOrderSuccess({
        side: 'BUY',
        amountUsd: 1.23,
        tokens: 3.21,
        price: 0.38,
        tokenId: 'email-test-token-id',
        conditionId: 'email-test-condition-id',
        trader: '0x0000000000000000000000000000000000000000',
        title: 'Email Test - SMTP connectivity check',
        txHash: `email-test-${Date.now()}`,
    });

    console.log('✅ 测试流程已执行完成。');
    console.log('如果未收到邮件，请查看上方 [邮件通知] 日志错误信息。');
};

run().catch((error) => {
    console.error(`❌ 测试失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
