/**
 * Dry Run Entry Point
 *
 * 模拟跟单测试模式 — 不执行真实交易
 * 用法: npm run dryrun
 *
 * 功能:
 * - 启动 tradeMonitor 检测跟单钱包的新交易（写 MongoDB）
 * - dryRunExecutor 读取新交易，按订单簿模拟成交
 * - 维护模拟余额和持仓，跟踪实时盈亏
 * - 所有策略配置(COPY_STRATEGY/COPY_MODE/分层倍数)全部生效
 */

import connectDB, { closeDB } from './config/db';
import createClobClient from './utils/createClobClient';
import tradeMonitor, { stopTradeMonitor } from './services/tradeMonitor';
import dryRunExecutor, { stopDryRunExecutor } from './services/dryRunExecutor';
import Logger from './utils/logger';

let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
        process.exit(1);
    }
    isShuttingDown = true;
    Logger.separator();
    Logger.info(`收到关闭信号 ${signal}，正在关闭...`);
    stopTradeMonitor();
    stopDryRunExecutor();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await closeDB();
    Logger.success('已关闭');
    process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const main = async () => {
    try {
        console.log('\n');
        console.log('\x1b[35m' + '  ____     ___                   ____            _     __  __                                          ');
        console.log('\x1b[35m' + ' |  _ \\   / _ \\ _ __   ___ _ __ |  _ \\ _   _  ___| | _|  \\/  | __ _ _ __   __ _  __ _  ___ _ __ ');
        console.log("\x1b[35m" + " | | | | | | | | '_ \\ / _ \\ '_ \\| |_) | | | |/ __| |/ / |\\/| |/ _` | '_ \\ / _` |/ _` |/ _ \\ '__|");
        console.log('\x1b[35m' + ' | |_| | | |_| | |_) |  __/ | | |  _ <| |_| | (__|   <| |  | | (_| | | | | (_| | (_| |  __/ |   ');
        console.log('\x1b[35m' + ' |____/   \\___/| .__/ \\___|_| |_|_| \\_\\\\__,_|\\___|_|\\_\\_|  |_|\\__,_|_| |_|\\__, |\\__, |\\___|_|   ');
        console.log('\x1b[35m' + '                 |_|                                                        |___/ |___/            ');
        console.log('\x1b[33m' + '                        模拟跟单 · 实时监控 · 不执行真实交易\n');

        // Connect to DB (needed for tradeMonitor to write new trades)
        await connectDB();
        Logger.success('数据库连接就绪');

        Logger.info('正在初始化 CLOB 客户端...');
        const clobClient = await createClobClient();
        Logger.success('CLOB 客户端就绪');

        // Start both: tradeMonitor (writes to DB) + dryRunExecutor (reads & simulates)
        await Promise.all([
            tradeMonitor(),
            dryRunExecutor(clobClient),
        ]);
    } catch (error) {
        Logger.error(`启动失败: ${error}`);
        process.exit(1);
    }
};

main();
