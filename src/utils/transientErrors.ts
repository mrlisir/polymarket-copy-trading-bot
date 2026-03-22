/**
 * 判断是否为「临时性」网络/数据库故障，适合指数退避重试而非退出进程。
 * 退避参数来自 ENV（TRANSIENT_RETRY_*）。
 */

import { ENV } from '../config/env';

export const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

const MONGO_RETRYABLE_NAMES = new Set([
    'MongoNetworkError',
    'MongoServerSelectionError',
    'MongoTimeoutError',
    'MongoExpiredSessionError',
    'MongoWriteConcernError',
]);

/**
 * 连续第 streak 次失败时的退避毫秒（指数增长，有上限）。
 * delay = min(BASE * 2^min(streak-1, MAX_EXPONENT), MAX_MS)
 */
export const transientBackoffMs = (streak: number): number => {
    const baseMs = ENV.TRANSIENT_RETRY_BASE_MS;
    const maxMs = ENV.TRANSIENT_RETRY_MAX_MS;
    const maxExp = ENV.TRANSIENT_BACKOFF_MAX_EXPONENT;
    if (streak <= 0) return baseMs;
    return Math.min(baseMs * Math.pow(2, Math.min(streak - 1, maxExp)), maxMs);
};

export const isRetryableTransientError = (error: unknown): boolean => {
    if (error == null) return false;

    const name = error instanceof Error ? error.name : '';
    const msg = error instanceof Error ? error.message : String(error);
    const combined = `${name} ${msg}`.toLowerCase();

    if (MONGO_RETRYABLE_NAMES.has(name)) return true;

    const hints = [
        'econnreset',
        'etimedout',
        'econnrefused',
        'enotfound',
        'eai_again',
        'socket hang up',
        'socket disconnected',
        'disconnected before secure tls',
        'tls connection',
        'network error',
        'fetch failed',
        'failed to fetch',
        'read econnreset',
        'write econnreset',
        'mongonetworkerror',
        'mongoserverselectionerror',
        'cannot use a session that has ended',
    ];
    return hints.some((h) => combined.includes(h));
};
