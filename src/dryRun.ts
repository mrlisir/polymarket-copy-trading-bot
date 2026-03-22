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
 * - 所有策略配置(COPY_STRATEGY/分层倍数)与跟单地址列(USER_ADDRESSES_FOLLOW/REVERSE)全部生效
 */

import connectDB, { closeDB } from './config/db';
import { ENV, reloadEnvFromDisk } from './config/env';
import createClobClient from './utils/createClobClient';
import tradeMonitor, { stopTradeMonitor } from './services/tradeMonitor';
import dryRunExecutor, { stopDryRunExecutor } from './services/dryRunExecutor';
import Logger from './utils/logger';
import { isRetryableTransientError, transientBackoffMs, sleep } from './utils/transientErrors';

let isShuttingDown = false;
let envReloadTimer: ReturnType<typeof setInterval> | undefined;
let lastEnvReloadAt = 0;

const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
        process.exit(1);
    }
    isShuttingDown = true;
    Logger.separator();
    Logger.info(`收到关闭信号 ${signal}，正在关闭...`);
    if (envReloadTimer) {
        clearInterval(envReloadTimer);
        envReloadTimer = undefined;
    }
    stopTradeMonitor();
    stopDryRunExecutor();
    if (ENV.TRANSIENT_RESTART_SETTLE_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, ENV.TRANSIENT_RESTART_SETTLE_MS));
    }
    await closeDB();
    Logger.success('已关闭');
    process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const createClobClientWithRetry = async () => {
    let streak = 0;
    const maxAttempts = ENV.CLOB_INIT_MAX_ATTEMPTS;
    while (true) {
        try {
            return await createClobClient();
        } catch (e) {
            streak += 1;
            if (!isRetryableTransientError(e) || streak >= maxAttempts) throw e;
            const delayMs = transientBackoffMs(streak);
            Logger.warning(
                `CLOB 初始化失败，约 ${(delayMs / 1000).toFixed(1)}s 后重试（第 ${streak}/${maxAttempts} 次）: ${e}`
            );
            await sleep(delayMs);
        }
    }
};

const main = async () => {
    console.log('\n');
    console.log('\x1b[35m' + '  ____     ___                   ____            _     __  __                                          ');
    console.log('\x1b[35m' + ' |  _ \\   / _ \\ _ __   ___ _ __ |  _ \\ _   _  ___| | _|  \\/  | __ _ _ __   __ _  __ _  ___ _ __ ');
    console.log("\x1b[35m" + " | | | | | | | | '_ \\ / _ \\ '_ \\| |_) | | | |/ __| |/ / |\\/| |/ _` | '_ \\ / _` |/ _` |/ _ \\ '__|");
    console.log('\x1b[35m' + ' | |_| | | |_| | |_) |  __/ | | |  _ <| |_| | (__|   <| |  | | (_| | | | | (_| | (_| |  __/ |   ');
    console.log('\x1b[35m' + ' |____/   \\___/| .__/ \\___|_| |_|_| \\_\\\\__,_|\\___|_|\\_\\_|  |_|\\__,_|_| |_|\\__, |\\__, |\\___|_|   ');
    console.log('\x1b[35m' + '                 |_|                                                        |___/ |___/            ');
    console.log('\x1b[33m' + '                        模拟跟单 · 实时监控 · 不执行真实交易\n');

    let streak = 0;
    while (!isShuttingDown) {
        try {
            await connectDB();
            streak = 0;
            Logger.success('数据库连接就绪');

            Logger.info('正在初始化 CLOB 客户端...');
            const clobClient = await createClobClientWithRetry();
            Logger.success('CLOB 客户端就绪');

            lastEnvReloadAt = 0;
            envReloadTimer = setInterval(() => {
                const ms = ENV.ENV_FILE_RELOAD_INTERVAL_MS;
                if (!ms || ms <= 0) return;
                const now = Date.now();
                if (now - lastEnvReloadAt < ms) return;
                lastEnvReloadAt = now;
                const r = reloadEnvFromDisk();
                if (r.ok) {
                    Logger.success(r.message);
                } else {
                    Logger.warning(`.env 热更新失败，沿用原配置: ${r.error}`);
                }
            }, 1000);

            await Promise.all([tradeMonitor(), dryRunExecutor(clobClient)]);
            if (envReloadTimer) {
                clearInterval(envReloadTimer);
                envReloadTimer = undefined;
            }
            break;
        } catch (error) {
            if (isShuttingDown) break;
            if (!isRetryableTransientError(error)) {
                Logger.error(`启动失败（不可重试）: ${error}`);
                process.exit(1);
            }
            streak += 1;
            const delayMs = transientBackoffMs(streak);
            Logger.warning(
                `模拟模式临时故障，约 ${(delayMs / 1000).toFixed(1)}s 后重连重试（第 ${streak} 次）: ${error}`
            );
            stopTradeMonitor();
            stopDryRunExecutor();
            if (ENV.TRANSIENT_RESTART_SETTLE_MS > 0) {
                await sleep(ENV.TRANSIENT_RESTART_SETTLE_MS);
            }
            try {
                await closeDB();
            } catch {
                // ignore
            }
            await sleep(delayMs);
        }
    }
};

main();
