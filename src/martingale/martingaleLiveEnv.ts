/**
 * @author li.mingfeng
 * 马丁格尔实盘：`npm run martingale-live` 可将链/RPC/CLOB/钱包等与跟单根 `.env` 分离（见 MARTINGALE_LIVE_CONFIG_ISOLATED 与各 MARTINGALE_LIVE_* 键）。
 */

import { ENV, syncHttpProxySideEffects } from '../config/env';

const DEFAULT_MARTINGALE_LIVE_CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws';

export type MartingaleLiveEnvApplyResult = {
    isolated: boolean;
    /** 已写入 process.env 与 ENV 的项（摘要） */
    appliedSummary: string[];
};

const req = (name: string): string => {
    const v = (process.env[name] || '').trim();
    if (!v) {
        throw new Error(
            `MARTINGALE_LIVE_CONFIG_ISOLATED=true 时须在 .env.martingale 配置 ${name}（马丁与跟单 .env 分离，不再沿用根 .env 缺省）。`
        );
    }
    return v;
};

/**
 * 在健康检查 / CLOB 初始化之前调用：将 MARTINGALE_LIVE_* 写入 process.env 与运行时 ENV。
 * - `MARTINGALE_LIVE_CONFIG_ISOLATED=true`：强制从下列键读取 RPC/CLOB/钱包等（不再使用根 .env 中的同名项）。
 * - 未开启隔离：仅当某 MARTINGALE_LIVE_* 非空时覆盖对应项（与根 .env 合并后仍可局部覆盖）。
 */
export const applyMartingaleLiveRuntimeOverrides = (): MartingaleLiveEnvApplyResult => {
    const isolated = process.env.MARTINGALE_LIVE_CONFIG_ISOLATED === 'true';
    const appliedSummary: string[] = [];
    if (!isolated) {
        delete process.env.MARTINGALE_LIVE_SKIP_MONGO;
    }

    const setPair = (procKey: string, value: string, envField: 'RPC_URL' | 'CLOB_HTTP_URL' | 'CLOB_WS_URL'): void => {
        process.env[procKey] = value;
        ENV[envField] = value;
    };

    if (isolated) {
        setPair('RPC_URL', req('MARTINGALE_LIVE_RPC_URL'), 'RPC_URL');
        appliedSummary.push('RPC_URL(隔离)');
        setPair('CLOB_HTTP_URL', req('MARTINGALE_LIVE_CLOB_HTTP_URL'), 'CLOB_HTTP_URL');
        appliedSummary.push('CLOB_HTTP_URL(隔离)');
        const wsMart = (process.env.MARTINGALE_LIVE_CLOB_WS_URL || '').trim();
        const ws = wsMart || DEFAULT_MARTINGALE_LIVE_CLOB_WS;
        setPair('CLOB_WS_URL', ws, 'CLOB_WS_URL');
        appliedSummary.push(wsMart ? 'CLOB_WS_URL(隔离)' : 'CLOB_WS_URL(默认)');
        const pk = req('MARTINGALE_LIVE_PRIVATE_KEY');
        process.env.PRIVATE_KEY = pk;
        ENV.PRIVATE_KEY = pk;
        appliedSummary.push('PRIVATE_KEY(隔离)');
        const pw = req('MARTINGALE_LIVE_PROXY_WALLET');
        process.env.PROXY_WALLET = pw;
        ENV.PROXY_WALLET = pw;
        appliedSummary.push('PROXY_WALLET(隔离)');
        const mongo = (process.env.MARTINGALE_LIVE_MONGO_URI || '').trim();
        if (mongo) {
            process.env.MONGO_URI = mongo;
            ENV.MONGO_URI = mongo;
            process.env.MARTINGALE_LIVE_SKIP_MONGO = 'false';
            appliedSummary.push('MONGO_URI(隔离)');
        } else {
            process.env.MARTINGALE_LIVE_SKIP_MONGO = 'true';
            process.env.MONGO_URI = '';
            ENV.MONGO_URI = '';
            appliedSummary.push('Mongo(隔离·未配置，已跳过)');
        }
        const usdc = req('MARTINGALE_LIVE_USDC_CONTRACT_ADDRESS');
        process.env.USDC_CONTRACT_ADDRESS = usdc;
        ENV.USDC_CONTRACT_ADDRESS = usdc;
        appliedSummary.push('USDC_CONTRACT_ADDRESS(隔离)');
    } else {
        const rpc = (process.env.MARTINGALE_LIVE_RPC_URL || '').trim();
        if (rpc) {
            setPair('RPC_URL', rpc, 'RPC_URL');
            appliedSummary.push('RPC_URL');
        }
        const ch = (process.env.MARTINGALE_LIVE_CLOB_HTTP_URL || '').trim();
        if (ch) {
            setPair('CLOB_HTTP_URL', ch, 'CLOB_HTTP_URL');
            appliedSummary.push('CLOB_HTTP_URL');
        }
        const cws = (process.env.MARTINGALE_LIVE_CLOB_WS_URL || '').trim();
        if (cws) {
            setPair('CLOB_WS_URL', cws, 'CLOB_WS_URL');
            appliedSummary.push('CLOB_WS_URL');
        }
        const pk = (process.env.MARTINGALE_LIVE_PRIVATE_KEY || '').trim();
        if (pk) {
            process.env.PRIVATE_KEY = pk;
            ENV.PRIVATE_KEY = pk;
            appliedSummary.push('PRIVATE_KEY');
        }
        const pw = (process.env.MARTINGALE_LIVE_PROXY_WALLET || '').trim();
        if (pw) {
            process.env.PROXY_WALLET = pw;
            ENV.PROXY_WALLET = pw;
            appliedSummary.push('PROXY_WALLET');
        }
        const mongo = (process.env.MARTINGALE_LIVE_MONGO_URI || '').trim();
        if (mongo) {
            process.env.MONGO_URI = mongo;
            ENV.MONGO_URI = mongo;
            process.env.MARTINGALE_LIVE_SKIP_MONGO = 'false';
            appliedSummary.push('MONGO_URI');
        }
        const usdc = (process.env.MARTINGALE_LIVE_USDC_CONTRACT_ADDRESS || '').trim();
        if (usdc) {
            process.env.USDC_CONTRACT_ADDRESS = usdc;
            ENV.USDC_CONTRACT_ADDRESS = usdc;
            appliedSummary.push('USDC_CONTRACT_ADDRESS');
        }
    }

    const martProxyOn = (process.env.MARTINGALE_LIVE_HTTP_PROXY_ENABLED || '').trim();
    if (isolated && martProxyOn !== 'true') {
        process.env.HTTP_PROXY_ENABLED = 'false';
        ENV.HTTP_PROXY_ENABLED = false;
        appliedSummary.push('HTTP_PROXY(隔离·关，未启用MARTINGALE_LIVE_HTTP_PROXY)');
    }

    if (martProxyOn === 'true') {
        process.env.HTTP_PROXY_ENABLED = 'true';
        ENV.HTTP_PROXY_ENABLED = true;
        const h = (process.env.MARTINGALE_LIVE_HTTP_PROXY_HOST || '').trim();
        if (h) {
            process.env.HTTP_PROXY_HOST = h;
            ENV.HTTP_PROXY_HOST = h;
        }
        const pRaw = (process.env.MARTINGALE_LIVE_HTTP_PROXY_PORT || '').trim();
        if (pRaw) {
            const p = parseInt(pRaw, 10);
            if (Number.isFinite(p)) {
                process.env.HTTP_PROXY_PORT = String(p);
                ENV.HTTP_PROXY_PORT = p;
            }
        }
        const bypass = (process.env.MARTINGALE_LIVE_HTTP_PROXY_BYPASS_RPC || '').trim();
        if (bypass === 'true' || bypass === 'false') {
            process.env.HTTP_PROXY_BYPASS_RPC = bypass;
            ENV.HTTP_PROXY_BYPASS_RPC = bypass === 'true';
        }
        appliedSummary.push('HTTP_PROXY(马丁专用)');
    }

    syncHttpProxySideEffects();

    return { isolated, appliedSummary };
};
