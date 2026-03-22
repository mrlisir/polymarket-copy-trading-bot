import * as dotenv from 'dotenv';
dotenv.config();

import connectDB, { closeDB } from '../config/db';
import { performHealthCheck, logHealthCheck } from '../utils/healthCheck';
import { ENV, buildCopyModeStartupSummary, getCopyModeForTrader } from '../config/env';
import { copyModeLabelZhShort, copyModeEnvColumnHint } from '../config/copyStrategy';

const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
};

function printHeader() {
    console.log(`\n${colors.cyan}${colors.bright}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('     🏥 POLYMARKET BOT - HEALTH CHECK');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`${colors.reset}\n`);
}

function printRecommendations(result: any) {
    const issues: string[] = [];

    if (result.checks.database.status === 'error') {
        issues.push('❌ 数据库连接失败');
        console.log(`${colors.red}${colors.bright}\n📋 数据库问题:${colors.reset}`);
        console.log('   • 检查 .env 文件中的 MONGO_URI');
        console.log('   • 确认 MongoDB Atlas IP 白名单 (允许 0.0.0.0/0)');
        console.log('   • 确认数据库用户权限正确');
        console.log('   • 测试连接: https://www.mongodb.com/docs/atlas/troubleshoot-connection\n');
    }

    if (result.checks.rpc.status === 'error') {
        issues.push('❌ RPC 节点连接失败');
        console.log(`${colors.red}${colors.bright}\n📋 RPC 问题:${colors.reset}`);
        console.log('   • 检查 .env 文件中的 RPC_URL');
        console.log('   • 确认您的 API 密钥有效');
        console.log('   • 尝试其他提供商:');
        console.log('     - Infura: https://infura.io');
        console.log('     - Alchemy: https://www.alchemy.com\n');
    }

    if (result.checks.balance.status === 'error') {
        issues.push('❌ USDC 余额为零');
        console.log(`${colors.red}${colors.bright}\n📋 余额问题:${colors.reset}`);
        console.log('   • 您的钱包中没有 USDC');
        console.log('   • 将 USDC 跨链到 Polygon: https://wallet.polygon.technology/polygon/bridge/deposit');
        console.log('   • 或在交易所购买 USDC 并提现到 Polygon 网络');
        console.log('   • 同时准备 POL (MATIC) 作为 Gas 费 (约 $5-10)\n');
    } else if (result.checks.balance.status === 'warning') {
        console.log(`${colors.yellow}${colors.bright}\n⚠️  余额不足警告:${colors.reset}`);
        console.log(`   • 当前余额: $${result.checks.balance.balance?.toFixed(2) || '0.00'}`);
        console.log('   • 建议增加 USDC 以避免错过交易');
        console.log('   • 活跃交易建议最低: $50-100\n');
    }

    if (result.checks.polymarketApi.status === 'error') {
        issues.push('❌ Polymarket API 连接失败');
        console.log(`${colors.red}${colors.bright}\n📋 API 问题:${colors.reset}`);
        console.log('   • Polymarket API 无响应');
        console.log('   • 请检查网络连接');
        console.log('   • Polymarket 可能正在维护');
        console.log('   • 查看状态: https://polymarket.com\n');
    }

    if (issues.length === 0) {
        console.log(`${colors.green}${colors.bright}\n🎉 所有系统运行正常！${colors.reset}\n`);
        console.log(`${colors.cyan}您可以开始交易了:${colors.reset}`);
        console.log(`   ${colors.green}npm start${colors.reset}\n`);
    } else {
        console.log(`${colors.red}${colors.bright}\n⚠️  发现 ${issues.length} 个问题${colors.reset}`);
        console.log(`\n${colors.yellow}请先修复上述问题后再启动机器人。${colors.reset}\n`);
    }
}

function printConfiguration() {
    console.log(`${colors.cyan}📊 配置摘要:${colors.reset}\n`);
    console.log(`   交易钱包: ${ENV.PROXY_WALLET.slice(0, 6)}...${ENV.PROXY_WALLET.slice(-4)}`);
    console.log(`   正在跟踪 ${ENV.USER_ADDRESSES.length} 位交易员:`);
    console.log(`   ${buildCopyModeStartupSummary()}`);
    ENV.USER_ADDRESSES.forEach((addr, idx) => {
        const m = getCopyModeForTrader(addr);
        console.log(
            `      ${idx + 1}. ${addr.slice(0, 6)}...${addr.slice(-4)}  [${copyModeLabelZhShort(m)} · ${copyModeEnvColumnHint(m)}]`
        );
    });
    console.log(`   检查间隔: ${ENV.FETCH_INTERVAL}秒`);
    console.log(`   交易乘数: ${ENV.TRADE_MULTIPLIER}x`);
    console.log('');
}

const main = async () => {
    try {
        printHeader();
        console.log(`${colors.yellow}⏳ 正在运行诊断检查...${colors.reset}\n`);

        await connectDB();
        const result = await performHealthCheck();

        logHealthCheck(result);
        printConfiguration();
        printRecommendations(result);

        if (result.healthy) {
            process.exit(0);
        } else {
            process.exit(1);
        }
    } catch (error) {
        console.error(`\n${colors.red}${colors.bright}❌ 健康检查错误${colors.reset}\n`);
        if (error instanceof Error) {
            console.error(`${error.message}\n`);
            console.error(`${colors.yellow}💡 提示: 运行设置向导重新配置:${colors.reset}`);
            console.error(`   ${colors.cyan}npm run setup${colors.reset}\n`);
        } else {
            console.error(error);
        }
        process.exit(1);
    } finally {
        await closeDB();
    }
};

main();
