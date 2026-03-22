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
        console.error('📖 详细说明请参阅: docs/快速开始.md\n');
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

    const httpProxyPort = parseInt(process.env.HTTP_PROXY_PORT || '7890', 10);
    if (isNaN(httpProxyPort) || httpProxyPort <= 0 || httpProxyPort > 65535) {
        throw new Error(
            `Invalid HTTP_PROXY_PORT: ${process.env.HTTP_PROXY_PORT}. Must be between 1 and 65535.`
        );
    }

    const doubleSideGuardLockTtlMs = parseInt(
        process.env.COPY_DOUBLE_SIDE_GUARD_LOCK_TTL_MS || '600000',
        10
    );
    if (isNaN(doubleSideGuardLockTtlMs) || doubleSideGuardLockTtlMs < 1000) {
        throw new Error(
            `Invalid COPY_DOUBLE_SIDE_GUARD_LOCK_TTL_MS: ${process.env.COPY_DOUBLE_SIDE_GUARD_LOCK_TTL_MS}. Must be at least 1000ms.`
        );
    }

    const copyStopLossStreak = parseInt(process.env.COPY_STOP_LOSS_STREAK || '10', 10);
    if (isNaN(copyStopLossStreak) || copyStopLossStreak < 1) {
        throw new Error(
            `Invalid COPY_STOP_LOSS_STREAK: ${process.env.COPY_STOP_LOSS_STREAK}. Must be at least 1.`
        );
    }

    const copyStopLossUsd = parseFloat(process.env.COPY_STOP_LOSS_USD || '50');
    if (isNaN(copyStopLossUsd) || copyStopLossUsd <= 0) {
        throw new Error(
            `Invalid COPY_STOP_LOSS_USD: ${process.env.COPY_STOP_LOSS_USD}. Must be positive.`
        );
    }

    const transientRetryBaseMs = parseInt(process.env.TRANSIENT_RETRY_BASE_MS || '2000', 10);
    if (isNaN(transientRetryBaseMs) || transientRetryBaseMs < 500 || transientRetryBaseMs > 600_000) {
        throw new Error(
            `Invalid TRANSIENT_RETRY_BASE_MS: ${process.env.TRANSIENT_RETRY_BASE_MS}. Must be 500–600000.`
        );
    }

    const transientRetryMaxMs = parseInt(process.env.TRANSIENT_RETRY_MAX_MS || '120000', 10);
    if (isNaN(transientRetryMaxMs) || transientRetryMaxMs < transientRetryBaseMs) {
        throw new Error(
            `Invalid TRANSIENT_RETRY_MAX_MS: ${process.env.TRANSIENT_RETRY_MAX_MS}. Must be >= TRANSIENT_RETRY_BASE_MS.`
        );
    }

    const transientBackoffMaxExponent = parseInt(
        process.env.TRANSIENT_BACKOFF_MAX_EXPONENT || '16',
        10
    );
    if (isNaN(transientBackoffMaxExponent) || transientBackoffMaxExponent < 0 || transientBackoffMaxExponent > 32) {
        throw new Error(
            `Invalid TRANSIENT_BACKOFF_MAX_EXPONENT: ${process.env.TRANSIENT_BACKOFF_MAX_EXPONENT}. Must be 0–32.`
        );
    }

    const clobInitMaxAttempts = parseInt(process.env.CLOB_INIT_MAX_ATTEMPTS || '12', 10);
    if (isNaN(clobInitMaxAttempts) || clobInitMaxAttempts < 1 || clobInitMaxAttempts > 100) {
        throw new Error(
            `Invalid CLOB_INIT_MAX_ATTEMPTS: ${process.env.CLOB_INIT_MAX_ATTEMPTS}. Must be 1–100.`
        );
    }

    const transientRestartSettleMs = parseInt(process.env.TRANSIENT_RESTART_SETTLE_MS || '2000', 10);
    if (isNaN(transientRestartSettleMs) || transientRestartSettleMs < 0 || transientRestartSettleMs > 120_000) {
        throw new Error(
            `Invalid TRANSIENT_RESTART_SETTLE_MS: ${process.env.TRANSIENT_RESTART_SETTLE_MS}. Must be 0–120000.`
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
    // Optional HTTP proxy for outbound API requests
    HTTP_PROXY_ENABLED: process.env.HTTP_PROXY_ENABLED === 'true',
    HTTP_PROXY_HOST: (process.env.HTTP_PROXY_HOST || '127.0.0.1').trim(),
    HTTP_PROXY_PORT: parseInt(process.env.HTTP_PROXY_PORT || '7890', 10),
    // When true, keep RPC direct by adding RPC host into NO_PROXY.
    // Set false if your network requires RPC requests through HTTP proxy.
    HTTP_PROXY_BYPASS_RPC: process.env.HTTP_PROXY_BYPASS_RPC !== 'false',
    // Trade aggregation settings
    TRADE_AGGREGATION_ENABLED: process.env.TRADE_AGGREGATION_ENABLED === 'true',
    TRADE_AGGREGATION_WINDOW_SECONDS: parseInt(
        process.env.TRADE_AGGREGATION_WINDOW_SECONDS || '300',
        10
    ), // 5 minutes default
    MONGO_URI: process.env.MONGO_URI as string,
    RPC_URL: process.env.RPC_URL as string,
    USDC_CONTRACT_ADDRESS: process.env.USDC_CONTRACT_ADDRESS as string,
    // Dry run (simulation) settings
    DRY_INITIAL_BALANCE: parseFloat(process.env.DRY_INITIAL_BALANCE || '1000.0'),
    DRY_HISTORY_HOURS: parseFloat(process.env.DRY_HISTORY_HOURS || '24'),
    DRY_REPLAY_SPEED: parseFloat(process.env.DRY_REPLAY_SPEED || '1000'),
    DRY_REALTIME: process.env.DRY_REALTIME === 'true',
    // When true: load real positions from Polymarket as starting point; false: start fresh
    DRY_START_FROM_REAL: process.env.DRY_START_FROM_REAL !== 'false',
    // In dry-run mode, cap how many pending trades to process per loop
    // to avoid console flooding on startup when Mongo already has many bot-claimed trades.
    DRY_MAX_TRADES_PER_RUN: parseInt(process.env.DRY_MAX_TRADES_PER_RUN || '20', 10),

    // Orderbook caching (to reduce API load and 404 spam)
    ORDERBOOK_CACHE_TTL_MS: parseInt(process.env.ORDERBOOK_CACHE_TTL_MS || '30000', 10),
    ORDERBOOK_CACHE_MAX_ENTRIES: parseInt(process.env.ORDERBOOK_CACHE_MAX_ENTRIES || '500', 10),
    ORDERBOOK_MISSING_LOG_THROTTLE_MS: parseInt(
        process.env.ORDERBOOK_MISSING_LOG_THROTTLE_MS || '60000',
        10
    ),

    // Price guard for BUY side (avoid buying too far away from the trader's price)
    ORDER_PRICE_SLIPPAGE_USD: parseFloat(process.env.ORDER_PRICE_SLIPPAGE_USD || '0.05'),

    // curPrice cache (Polymarket positions API) — used for dryrun + optional live portfolio log
    CUR_PRICE_CACHE_TTL_MS: parseInt(process.env.CUR_PRICE_CACHE_TTL_MS || '15000', 10),

    /** Data API positions?user= 共享缓存 TTL（tradeMonitor / 对账 / curPrice 等多处复用） */
    DATA_API_POSITIONS_CACHE_TTL_MS: parseInt(process.env.DATA_API_POSITIONS_CACHE_TTL_MS || '10000', 10),

    /** CLOB /midpoint、/last-trade-price 缓存 TTL（估值优先于整本 orderbook） */
    CLOB_LIGHT_PRICE_CACHE_TTL_MS: parseInt(process.env.CLOB_LIGHT_PRICE_CACHE_TTL_MS || '15000', 10),

    /**
     * positions curPrice 与 CLOB 订单簿 mid 差值超过此阈值（美元概率价 0~1）时，用 mid 估值。
     * dry run 与实盘 getProxyPortfolioMarkUsd(clob) 共用。
     */
    MARK_CUR_VS_BOOK_DIVERGENCE: parseFloat(process.env.MARK_CUR_VS_BOOK_DIVERGENCE || '0.12'),

    // Dry run: print simulated positions snapshot periodically (0 = disable)
    DRY_POSITIONS_SNAPSHOT_INTERVAL_MS: parseInt(
        process.env.DRY_POSITIONS_SNAPSHOT_INTERVAL_MS || '30000',
        10
    ),

    // Live: log proxy portfolio mark (sum size*curPrice) after trades, min interval ms (0 = off)
    LIVE_PORTFOLIO_CURPRICE_LOG_INTERVAL_MS: parseInt(
        process.env.LIVE_PORTFOLIO_CURPRICE_LOG_INTERVAL_MS || '0',
        10
    ),

    /**
     * 防止同一市场两头买的风控模式：
     * - GLOBAL: 只要该 condition 已持有另一侧，就跳过新的 opposite BUY（默认）
     * - TRADER_ONLY: 仅当「同一交易员」对应的另一侧仍有已跟单仓位时才跳过
     * - OFF: 关闭此风控
     */
    COPY_DOUBLE_SIDE_GUARD_MODE: (
        process.env.COPY_DOUBLE_SIDE_GUARD_MODE || 'GLOBAL'
    ).trim().toUpperCase(),
    /**
     * 两头买内存锁 TTL（毫秒）：
     * 当同一 condition 已在本进程买入某一侧后，在 TTL 期间阻止另一侧 BUY，
     * 用于覆盖 positions API 延迟窗口导致的双向新增仓位。
     */
    COPY_DOUBLE_SIDE_GUARD_LOCK_TTL_MS: parseInt(
        process.env.COPY_DOUBLE_SIDE_GUARD_LOCK_TTL_MS || '600000',
        10
    ),
    /**
     * 跟单亏损熔断：
     * 达到连续亏损次数或累计亏损金额后，停止跟单该交易员地址（仅本次进程）。
     */
    COPY_STOP_ON_LOSS_ENABLED: process.env.COPY_STOP_ON_LOSS_ENABLED !== 'false',
    COPY_STOP_LOSS_STREAK: parseInt(process.env.COPY_STOP_LOSS_STREAK || '10', 10),
    COPY_STOP_LOSS_USD: parseFloat(process.env.COPY_STOP_LOSS_USD || '50'),

    /**
     * Mongo/CLOB/网络临时故障时的指数退避（实盘、dryrun、tradeMonitor/Executor 共用）。
     * delay = min(BASE * 2^min(streak-1, MAX_EXPONENT), MAX_MS)
     */
    TRANSIENT_RETRY_BASE_MS: parseInt(process.env.TRANSIENT_RETRY_BASE_MS || '2000', 10),
    TRANSIENT_RETRY_MAX_MS: parseInt(process.env.TRANSIENT_RETRY_MAX_MS || '120000', 10),
    TRANSIENT_BACKOFF_MAX_EXPONENT: parseInt(process.env.TRANSIENT_BACKOFF_MAX_EXPONENT || '16', 10),
    /** CLOB createApiKey / 初始化最大尝试次数（每次失败会按上式退避） */
    CLOB_INIT_MAX_ATTEMPTS: parseInt(process.env.CLOB_INIT_MAX_ATTEMPTS || '12', 10),
    /** 停止子服务后等待多久再关库/重连（毫秒，0=不等待） */
    TRANSIENT_RESTART_SETTLE_MS: parseInt(process.env.TRANSIENT_RESTART_SETTLE_MS || '2000', 10),

    /**
     * 仓位对账周期（毫秒，0=关闭）。实盘（npm start / dev）与模拟（npm run dryrun）共用同一套变量。
     */
    POSITION_RECONCILE_INTERVAL_MS: parseInt(process.env.POSITION_RECONCILE_INTERVAL_MS || '0', 10),
    POSITION_RECONCILE_MAX_PER_RUN: parseInt(process.env.POSITION_RECONCILE_MAX_PER_RUN || '5', 10),
    POSITION_RECONCILE_COOLDOWN_MS: parseInt(process.env.POSITION_RECONCILE_COOLDOWN_MS || '120000', 10),
    /** When false, do not auto-sell because trader flat (only resolved path may run). */
    POSITION_RECONCILE_ON_TRADER_EXIT: process.env.POSITION_RECONCILE_ON_TRADER_EXIT !== 'false',
    /** When false, do not auto-sell on resolved/ redeemable / curPrice ~0/1. */
    POSITION_RECONCILE_ON_RESOLVED: process.env.POSITION_RECONCILE_ON_RESOLVED !== 'false',
    /** If true, after CLOB sell attempt, call on-chain redeemPositions for redeemable conditions (Polygon gas). */
    POSITION_RECONCILE_AUTO_REDEEM: process.env.POSITION_RECONCILE_AUTO_REDEEM === 'true',

    /**
     * 邮件通知（QQ 邮箱 SMTP）：
     * - EMAIL_NOTIFY_ENABLED=true 时启用
     * - 推荐 QQ SMTP: smtp.qq.com:465 (secure=true)
     * - EMAIL_SMTP_PASS 填 QQ 邮箱「授权码」，不是登录密码
     */
    EMAIL_NOTIFY_ENABLED: process.env.EMAIL_NOTIFY_ENABLED === 'true',
    EMAIL_SMTP_HOST: (process.env.EMAIL_SMTP_HOST || 'smtp.qq.com').trim(),
    EMAIL_SMTP_PORT: parseInt(process.env.EMAIL_SMTP_PORT || '465', 10),
    EMAIL_SMTP_SECURE: process.env.EMAIL_SMTP_SECURE !== 'false',
    EMAIL_SMTP_USER: (process.env.EMAIL_SMTP_USER || '').trim(),
    EMAIL_SMTP_PASS: (process.env.EMAIL_SMTP_PASS || '').trim(),
    EMAIL_FROM: (process.env.EMAIL_FROM || '').trim(),
    EMAIL_NOTIFY_TO: (process.env.EMAIL_NOTIFY_TO || '').trim(),
    /**
     * HTTP 邮件兜底（仅 Resend）：
     * SMTP 失败时可自动走 HTTPS API，适合代理/公司网络环境。
     */
    EMAIL_HTTP_FALLBACK_ENABLED: process.env.EMAIL_HTTP_FALLBACK_ENABLED === 'true',
    EMAIL_HTTP_PROVIDER: (process.env.EMAIL_HTTP_PROVIDER || 'AUTO').trim().toUpperCase(), // AUTO / RESEND
    EMAIL_HTTP_FROM: (process.env.EMAIL_HTTP_FROM || '').trim(),
    RESEND_API_KEY: (process.env.RESEND_API_KEY || '').trim(),

    /**
     * Polymarket Builder API（可选）：用于 CLOB 下单时附加 Builder 认证头，计入 Builder 量与排行榜。
     * 与 Relayer 文档中的 Builder 头一致，见 https://docs.polymarket.com/api-reference/relayer/submit-a-transaction
     * 切勿提交到 git；泄露请立即在 polymarket.com/settings?tab=builder 轮换密钥。
     */
    POLY_BUILDER_API_KEY: (process.env.POLY_BUILDER_API_KEY || '').trim(),
    POLY_BUILDER_SECRET: (process.env.POLY_BUILDER_SECRET || '').trim(),
    POLY_BUILDER_PASSPHRASE: (process.env.POLY_BUILDER_PASSPHRASE || '').trim(),
};

if (ENV.HTTP_PROXY_ENABLED && ENV.HTTP_PROXY_HOST) {
    const proxyUrl = `http://${ENV.HTTP_PROXY_HOST}:${ENV.HTTP_PROXY_PORT}`;
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;

    if (ENV.HTTP_PROXY_BYPASS_RPC) {
        // Keep RPC traffic direct when proxy is enabled.
        try {
            const rpcHost = new URL(ENV.RPC_URL).hostname;
            const noProxySet = new Set(
                (process.env.NO_PROXY || process.env.no_proxy || '')
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean)
            );
            noProxySet.add('localhost');
            noProxySet.add('127.0.0.1');
            noProxySet.add(rpcHost);
            const noProxy = Array.from(noProxySet).join(',');
            process.env.NO_PROXY = noProxy;
            process.env.no_proxy = noProxy;
        } catch {
            // Ignore malformed RPC_URL here; URL validity is validated above.
        }
    }
}
