import * as dotenv from 'dotenv';
import { CopyStrategy, CopyStrategyConfig, CopyMode, parseTieredMultipliers } from './copyStrategy';
dotenv.config();

/**
 * Validate Ethereum address format
 */
const isValidEthereumAddress = (address: string): boolean => {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
};

/**
 * Validate required environment variables
 */
const validateRequiredEnv = (): void => {
    const required = [
        'USER_ADDRESSES',
        'PROXY_WALLET',
        'PRIVATE_KEY',
        'CLOB_HTTP_URL',
        'CLOB_WS_URL',
        'MONGO_URI',
        'RPC_URL',
        'USDC_CONTRACT_ADDRESS',
    ];

    const missing: string[] = [];
    for (const key of required) {
        if (!process.env[key]) {
            missing.push(key);
        }
    }

    if (missing.length > 0) {
        console.error('\n❌ 配置错误：缺少必需的环境变量\n');
        console.error(`缺失的变量: ${missing.join(', ')}\n`);
        console.error('🔧 快速修复:');
        console.error('   1. 运行设置向导: npm run setup');
        console.error('   2. 或手动创建 .env 文件并填写所有必需变量\n');
        console.error('📖 详细说明请参阅: docs/QUICK_START.md\n');
        throw new Error(
            `缺少必需的环境变量: ${missing.join(', ')}`
        );
    }
};

/**
 * Validate Ethereum addresses
 */
const validateAddresses = (): void => {
    if (process.env.PROXY_WALLET && !isValidEthereumAddress(process.env.PROXY_WALLET)) {
        console.error('\n❌ 无效的钱包地址\n');
        console.error(`您的 PROXY_WALLET: ${process.env.PROXY_WALLET}`);
        console.error('期望格式:    0x 开头，后跟 40 位十六进制字符\n');
        console.error('示例: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0\n');
        console.error('💡 小提示:');
        console.error('   • 从 MetaMask 复制您的钱包地址');
        console.error('   • 确保地址以 0x 开头');
        console.error('   • 长度应恰好为 42 个字符\n');
        throw new Error(
            `无效的 PROXY_WALLET 地址格式: ${process.env.PROXY_WALLET}`
        );
    }

    if (
        process.env.USDC_CONTRACT_ADDRESS &&
        !isValidEthereumAddress(process.env.USDC_CONTRACT_ADDRESS)
    ) {
        console.error('\n❌ 无效的 USDC 合约地址\n');
        console.error(`当前值: ${process.env.USDC_CONTRACT_ADDRESS}`);
        console.error('默认值: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174\n');
        console.error('⚠️  除非您知道自己在做什么，否则请使用默认值！\n');
        throw new Error(
            `无效的 USDC_CONTRACT_ADDRESS 格式: ${process.env.USDC_CONTRACT_ADDRESS}`
        );
    }
};

/**
 * Validate numeric configuration values
 */
const validateNumericConfig = (): void => {
    const fetchInterval = parseInt(process.env.FETCH_INTERVAL || '1', 10);
    if (isNaN(fetchInterval) || fetchInterval <= 0) {
        throw new Error(
            `Invalid FETCH_INTERVAL: ${process.env.FETCH_INTERVAL}. Must be a positive integer.`
        );
    }

    const retryLimit = parseInt(process.env.RETRY_LIMIT || '3', 10);
    if (isNaN(retryLimit) || retryLimit < 1 || retryLimit > 10) {
        throw new Error(
            `Invalid RETRY_LIMIT: ${process.env.RETRY_LIMIT}. Must be between 1 and 10.`
        );
    }

    const tooOldTimestamp = parseFloat(process.env.TOO_OLD_TIMESTAMP || '24');
    if (isNaN(tooOldTimestamp) || tooOldTimestamp <= 0) {
        throw new Error(
            `Invalid TOO_OLD_TIMESTAMP: ${process.env.TOO_OLD_TIMESTAMP}. Must be a positive number (hours).`
        );
    }

    const requestTimeout = parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10);
    if (isNaN(requestTimeout) || requestTimeout < 1000) {
        throw new Error(
            `Invalid REQUEST_TIMEOUT_MS: ${process.env.REQUEST_TIMEOUT_MS}. Must be at least 1000ms.`
        );
    }

    const networkRetryLimit = parseInt(process.env.NETWORK_RETRY_LIMIT || '3', 10);
    if (isNaN(networkRetryLimit) || networkRetryLimit < 1 || networkRetryLimit > 10) {
        throw new Error(
            `Invalid NETWORK_RETRY_LIMIT: ${process.env.NETWORK_RETRY_LIMIT}. Must be between 1 and 10.`
        );
    }
};

/**
 * Validate URL formats
 */
const validateUrls = (): void => {
    if (process.env.CLOB_HTTP_URL && !process.env.CLOB_HTTP_URL.startsWith('http')) {
        console.error('\n❌ 无效的 CLOB_HTTP_URL\n');
        console.error(`当前值: ${process.env.CLOB_HTTP_URL}`);
        console.error('默认值: https://clob.polymarket.com/\n');
        console.error('⚠️  除非有特殊原因，否则请使用默认值！\n');
        throw new Error(
            `无效的 CLOB_HTTP_URL: ${process.env.CLOB_HTTP_URL}. 必须是有效的 HTTP/HTTPS URL。`
        );
    }

    if (process.env.CLOB_WS_URL && !process.env.CLOB_WS_URL.startsWith('ws')) {
        console.error('\n❌ 无效的 CLOB_WS_URL\n');
        console.error(`当前值: ${process.env.CLOB_WS_URL}`);
        console.error('默认值: wss://ws-subscriptions-clob.polymarket.com/ws\n');
        console.error('⚠️  除非有特殊原因，否则请使用默认值！\n');
        throw new Error(
            `无效的 CLOB_WS_URL: ${process.env.CLOB_WS_URL}. 必须是有效的 WebSocket URL (ws:// 或 wss://)。`
        );
    }

    if (process.env.RPC_URL && !process.env.RPC_URL.startsWith('http')) {
        console.error('\n❌ 无效的 RPC_URL\n');
        console.error(`当前值: ${process.env.RPC_URL}`);
        console.error('必须以: http:// 或 https:// 开头\n');
        console.error('💡 获取免费的 RPC 节点:');
        console.error('   • Infura:  https://infura.io');
        console.error('   • Alchemy: https://www.alchemy.com');
        console.error('   • Ankr:    https://www.ankr.com\n');
        console.error('示例: https://polygon-mainnet.infura.io/v3/YOUR_PROJECT_ID\n');
        throw new Error(`无效的 RPC_URL: ${process.env.RPC_URL}. 必须是有效的 HTTP/HTTPS URL。`);
    }

    if (process.env.MONGO_URI && !process.env.MONGO_URI.startsWith('mongodb')) {
        console.error('\n❌ 无效的 MONGO_URI\n');
        console.error(`当前值: ${process.env.MONGO_URI}`);
        console.error('必须以: mongodb:// 或 mongodb+srv:// 开头\n');
        console.error('💡 设置 MongoDB Atlas (免费):');
        console.error('   1. 访问 https://www.mongodb.com/cloud/atlas/register');
        console.error('   2. 创建一个免费集群');
        console.error('   3. 创建数据库用户并设置密码');
        console.error('   4. 添加 IP 白名单: 0.0.0.0/0（或您的 IP）');
        console.error('   5. 从 "Connect" 按钮获取连接字符串\n');
        console.error('示例: mongodb+srv://username:password@cluster.mongodb.net/database\n');
        throw new Error(
            `无效的 MONGO_URI: ${process.env.MONGO_URI}. 必须是有效的 MongoDB 连接字符串。`
        );
    }
};

// Run all validations
validateRequiredEnv();
validateAddresses();
validateNumericConfig();
validateUrls();

// Parse USER_ADDRESSES: supports both comma-separated string and JSON array
const parseUserAddresses = (input: string): string[] => {
    const trimmed = input.trim();
    // Check if it's JSON array format
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                const addresses = parsed
                    .map((addr) => addr.toLowerCase().trim())
                    .filter((addr) => addr.length > 0);
                // Validate each address
                for (const addr of addresses) {
                    if (!isValidEthereumAddress(addr)) {
                        console.error('\n❌ USER_ADDRESSES 中存在无效的交易员地址\n');
                        console.error(`无效地址: ${addr}`);
                        console.error('期望格式: 0x 开头，后跟 40 位十六进制字符\n');
                        console.error('💡 在哪里找到交易员地址:');
                        console.error('   • Polymarket 排行榜: https://polymarket.com/leaderboard');
                        console.error('   • Predictfolio: https://predictfolio.com\n');
                        console.error('示例: USER_ADDRESSES=\'0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b\'\n');
                        throw new Error(`USER_ADDRESSES 中存在无效的以太坊地址: ${addr}`);
                    }
                }
                return addresses;
            }
        } catch (e) {
            if (e instanceof Error && e.message.includes('Invalid Ethereum address')) {
                throw e;
            }
            throw new Error(
                `Invalid JSON format for USER_ADDRESSES: ${e instanceof Error ? e.message : String(e)}`
            );
        }
    }
    // Otherwise treat as comma-separated
    const addresses = trimmed
        .split(',')
        .map((addr) => addr.toLowerCase().trim())
        .filter((addr) => addr.length > 0);
    // Validate each address
    for (const addr of addresses) {
        if (!isValidEthereumAddress(addr)) {
            console.error('\n❌ USER_ADDRESSES 中存在无效的交易员地址\n');
            console.error(`无效地址: ${addr}`);
            console.error('期望格式: 0x 开头，后跟 40 位十六进制字符\n');
            console.error('💡 在哪里找到交易员地址:');
            console.error('   • Polymarket 排行榜: https://polymarket.com/leaderboard');
            console.error('   • Predictfolio: https://predictfolio.com\n');
            console.error('示例: USER_ADDRESSES=\'0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b\'\n');
            throw new Error(`USER_ADDRESSES 中存在无效的以太坊地址: ${addr}`);
        }
    }
    return addresses;
};

// Parse copy strategy configuration
const parseCopyStrategy = (): CopyStrategyConfig => {
    // Support legacy COPY_PERCENTAGE + TRADE_MULTIPLIER for backward compatibility
    const hasLegacyConfig = process.env.COPY_PERCENTAGE && !process.env.COPY_STRATEGY;

    if (hasLegacyConfig) {
        console.warn(
            '⚠️  正在使用旧的 COPY_PERCENTAGE 配置，建议迁移到 COPY_STRATEGY。'
        );
        const copyPercentage = parseFloat(process.env.COPY_PERCENTAGE || '10.0');
        const tradeMultiplier = parseFloat(process.env.TRADE_MULTIPLIER || '1.0');
        const effectivePercentage = copyPercentage * tradeMultiplier;

        const config: CopyStrategyConfig = {
            strategy: CopyStrategy.PERCENTAGE,
            copyMode: CopyMode.FOLLOW,
            copySize: effectivePercentage,
            maxOrderSizeUSD: parseFloat(process.env.MAX_ORDER_SIZE_USD || '100.0'),
            minOrderSizeUSD: parseFloat(process.env.MIN_ORDER_SIZE_USD || '1.0'),
            maxPositionSizeUSD: process.env.MAX_POSITION_SIZE_USD
                ? parseFloat(process.env.MAX_POSITION_SIZE_USD)
                : undefined,
            maxDailyVolumeUSD: process.env.MAX_DAILY_VOLUME_USD
                ? parseFloat(process.env.MAX_DAILY_VOLUME_USD)
                : undefined,
        };

        // Parse tiered multipliers if configured (even for legacy mode)
        if (process.env.TIERED_MULTIPLIERS) {
            try {
                config.tieredMultipliers = parseTieredMultipliers(process.env.TIERED_MULTIPLIERS);
                console.log(`✓ 已加载 ${config.tieredMultipliers.length} 个分层乘数`);
            } catch (error) {
                throw new Error(`Failed to parse TIERED_MULTIPLIERS: ${error instanceof Error ? error.message : String(error)}`);
            }
        } else if (tradeMultiplier !== 1.0) {
            // If using legacy single multiplier, store it
            config.tradeMultiplier = tradeMultiplier;
        }

        return config;
    }

    // Parse new copy strategy configuration
    const strategyStr = (process.env.COPY_STRATEGY || 'PERCENTAGE').toUpperCase();
    const strategy =
        CopyStrategy[strategyStr as keyof typeof CopyStrategy] || CopyStrategy.PERCENTAGE;

    const config: CopyStrategyConfig = {
        strategy,
        copyMode: CopyMode[(process.env.COPY_MODE || 'FOLLOW').toUpperCase() as keyof typeof CopyMode] || CopyMode.FOLLOW,
        copySize: parseFloat(process.env.COPY_SIZE || '10.0'),
        maxOrderSizeUSD: parseFloat(process.env.MAX_ORDER_SIZE_USD || '100.0'),
        minOrderSizeUSD: parseFloat(process.env.MIN_ORDER_SIZE_USD || '1.0'),
        maxPositionSizeUSD: process.env.MAX_POSITION_SIZE_USD
            ? parseFloat(process.env.MAX_POSITION_SIZE_USD)
            : undefined,
        maxDailyVolumeUSD: process.env.MAX_DAILY_VOLUME_USD
            ? parseFloat(process.env.MAX_DAILY_VOLUME_USD)
            : undefined,
    };

    // Add adaptive strategy parameters if applicable
    if (strategy === CopyStrategy.ADAPTIVE) {
        config.adaptiveMinPercent = parseFloat(
            process.env.ADAPTIVE_MIN_PERCENT || config.copySize.toString()
        );
        config.adaptiveMaxPercent = parseFloat(
            process.env.ADAPTIVE_MAX_PERCENT || config.copySize.toString()
        );
        config.adaptiveThreshold = parseFloat(process.env.ADAPTIVE_THRESHOLD_USD || '500.0');
    }

    console.log(`✓ 跟单模式: ${config.copyMode === CopyMode.REVERSE ? '反买 (REVERSE)' : '跟方向 (FOLLOW)'}`);

    // Parse tiered multipliers if configured
    if (process.env.TIERED_MULTIPLIERS) {
            try {
                config.tieredMultipliers = parseTieredMultipliers(process.env.TIERED_MULTIPLIERS);
                console.log(`✓ 已加载 ${config.tieredMultipliers.length} 个分层乘数`);
        } catch (error) {
            throw new Error(`Failed to parse TIERED_MULTIPLIERS: ${error instanceof Error ? error.message : String(error)}`);
        }
    } else if (process.env.TRADE_MULTIPLIER) {
        // Fall back to single multiplier if no tiers configured
        const singleMultiplier = parseFloat(process.env.TRADE_MULTIPLIER);
        if (singleMultiplier !== 1.0) {
            config.tradeMultiplier = singleMultiplier;
            console.log(`✓ 使用单一交易乘数: ${singleMultiplier}x`);
        }
    }

    return config;
};

export const ENV = {
    USER_ADDRESSES: parseUserAddresses(process.env.USER_ADDRESSES as string),
    PROXY_WALLET: process.env.PROXY_WALLET as string,
    PRIVATE_KEY: process.env.PRIVATE_KEY as string,
    CLOB_HTTP_URL: process.env.CLOB_HTTP_URL as string,
    CLOB_WS_URL: process.env.CLOB_WS_URL as string,
    FETCH_INTERVAL: parseInt(process.env.FETCH_INTERVAL || '1', 10),
    TOO_OLD_TIMESTAMP: parseFloat(process.env.TOO_OLD_TIMESTAMP || '24'),
    RETRY_LIMIT: parseInt(process.env.RETRY_LIMIT || '3', 10),
    // Legacy parameters (kept for backward compatibility)
    TRADE_MULTIPLIER: parseFloat(process.env.TRADE_MULTIPLIER || '1.0'),
    COPY_PERCENTAGE: parseFloat(process.env.COPY_PERCENTAGE || '10.0'),
    // New copy strategy configuration
    COPY_STRATEGY_CONFIG: parseCopyStrategy(),
    // Network settings
    REQUEST_TIMEOUT_MS: parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10),
    NETWORK_RETRY_LIMIT: parseInt(process.env.NETWORK_RETRY_LIMIT || '3', 10),
    // Trade aggregation settings
    TRADE_AGGREGATION_ENABLED: process.env.TRADE_AGGREGATION_ENABLED === 'true',
    TRADE_AGGREGATION_WINDOW_SECONDS: parseInt(
        process.env.TRADE_AGGREGATION_WINDOW_SECONDS || '300',
        10
    ), // 5 minutes default
    MONGO_URI: process.env.MONGO_URI as string,
    RPC_URL: process.env.RPC_URL as string,
    USDC_CONTRACT_ADDRESS: process.env.USDC_CONTRACT_ADDRESS as string,
};
