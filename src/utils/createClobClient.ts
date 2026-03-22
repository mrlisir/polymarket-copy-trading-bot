import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { SignatureType } from '@polymarket/order-utils';
import { ENV } from '../config/env';
import Logger from './logger';

/** 可选：Builder 凭证齐全时用于订单归因（与 Relayer 共用 POLY_BUILDER_* 签名体系） */
const getOptionalBuilderConfig = (): BuilderConfig | undefined => {
    const key = ENV.POLY_BUILDER_API_KEY;
    const secret = ENV.POLY_BUILDER_SECRET;
    const passphrase = ENV.POLY_BUILDER_PASSPHRASE;
    if (!key && !secret && !passphrase) {
        return undefined;
    }
    if (!key || !secret || !passphrase) {
        Logger.warning(
            '已设置部分 POLY_BUILDER_* 环境变量，但必须同时配置 POLY_BUILDER_API_KEY、POLY_BUILDER_SECRET、POLY_BUILDER_PASSPHRASE 才会启用 Builder 头。'
        );
        return undefined;
    }
    Logger.info('已启用 Polymarket Builder API：CLOB 下单将附带 Builder 认证（量计入 Builder 计划）');
    return new BuilderConfig({
        localBuilderCreds: { key, secret, passphrase },
    });
};

const createClobClient = async (): Promise<ClobClient> => {
    const chainId = 137;
    const host = ENV.CLOB_HTTP_URL as string;
    const provider = new ethers.providers.JsonRpcProvider(ENV.RPC_URL as string);
    const wallet = new ethers.Wallet(ENV.PRIVATE_KEY as string, provider);

    const walletAddr = (await wallet.getAddress()).toLowerCase();
    const proxyAddr = (ENV.PROXY_WALLET as string).toLowerCase();
    const sameAddress = walletAddr === proxyAddr;

    const signatureType = sameAddress ? SignatureType.EOA : SignatureType.POLY_PROXY;
    const funderAddress = sameAddress ? undefined : (ENV.PROXY_WALLET as string);

    Logger.info(
        sameAddress
            ? '正在创建 CLOB 客户端，签名类型: EOA（私钥地址与 PROXY_WALLET 相同）'
            : '正在创建 CLOB 客户端，签名类型: POLY_PROXY'
    );

    let clobClient = new ClobClient(
        host,
        chainId,
        wallet,
        undefined,
        signatureType,
        funderAddress
    );

    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;

    try {
        console.log = function () {};
        console.error = function () {};

        let creds = await clobClient.createApiKey();
        if (!creds.key) {
            Logger.warning('创建 API 密钥失败，正在尝试派生...');
            creds = await clobClient.deriveApiKey();
        }

        if (!creds.key) {
            throw new Error(
                'Failed to obtain Polymarket API credentials. Please check your private key and try again.'
            );
        }

        Logger.info('API 凭证获取成功');

        const builderConfig = getOptionalBuilderConfig();

        clobClient = new ClobClient(
            host,
            chainId,
            wallet,
            creds,
            signatureType,
            funderAddress,
            undefined,
            false,
            builderConfig
        );

        return clobClient;
    } finally {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
    }
};

export default createClobClient;
