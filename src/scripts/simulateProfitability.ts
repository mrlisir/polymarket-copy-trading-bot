import axios from 'axios';
import { ENV } from '../config/env';
import getMyBalance from '../utils/getMyBalance';

// Simple console colors without chalk
const colors = {
    cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
    green: (text: string) => `\x1b[32m${text}\x1b[0m`,
    red: (text: string) => `\x1b[31m${text}\x1b[0m`,
    yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
    blue: (text: string) => `\x1b[34m${text}\x1b[0m`,
    gray: (text: string) => `\x1b[90m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
};

interface Trade {
    id: string;
    timestamp: number;
    market: string;
    asset: string;
    side: 'BUY' | 'SELL';
    price: number;
    usdcSize: number;
    size: number;
    outcome: string;
}

interface Position {
    conditionId: string;
    market: string;
    outcome: string;
    outcomeIndex: number;
    asset: string;
    size: number;
    cost: number;
    avgEntryPrice: number;
    currentValue: number;
    realizedPnl: number;
    unrealizedPnl: number;
}

interface SimulationResult {
    id: string;
    name: string;
    logic: string;
    timestamp: number;
    traderAddress: string;
    startingCapital: number;
    currentCapital: number;
    totalTrades: number;
    copiedTrades: number;
    skippedTrades: number;
    totalInvested: number;
    currentValue: number;
    realizedPnl: number;
    unrealizedPnl: number;
    totalPnl: number;
    roi: number;
    positions: SimulatedPosition[];
}

interface SimulatedPosition {
    market: string;
    outcome: string;
    sharesHeld: number; // Track actual shares owned
    entryPrice: number;
    exitPrice: number | null;
    invested: number;
    currentValue: number;
    pnl: number;
    closed: boolean;
    trades: {
        timestamp: number;
        side: 'BUY' | 'SELL';
        price: number;
        size: number;
        usdcSize: number;
        traderPercent: number;
        yourSize: number;
    }[];
}

const DEFAULT_TRADER_ADDRESS = '0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b';
const TRADER_ADDRESS = (process.env.SIM_TRADER_ADDRESS || DEFAULT_TRADER_ADDRESS).toLowerCase();
const STARTING_CAPITAL = 1000; // Simulation with $1000 starting capital
const HISTORY_DAYS = (() => {
    const raw = process.env.SIM_HISTORY_DAYS;
    const value = raw ? Number(raw) : 7;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 7;
})();
const MULTIPLIER = ENV.TRADE_MULTIPLIER || 1.0;
const COPY_PERCENTAGE = (() => {
    const raw = process.env.COPY_PERCENTAGE;
    const value = raw ? Number(raw) : 10.0;
    return Number.isFinite(value) && value > 0 ? value : 10.0;
})(); // % of trader's order size to copy (default: 10%)
const MIN_ORDER_SIZE = (() => {
    const raw = process.env.SIM_MIN_ORDER_USD;
    const value = raw ? Number(raw) : 1.0;
    return Number.isFinite(value) && value > 0 ? value : 1.0;
})();
const MAX_TRADES_LIMIT = (() => {
    const raw = process.env.SIM_MAX_TRADES;
    const value = raw ? Number(raw) : 5000;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 5000;
})(); // Limit on number of trades for quick testing

async function fetchBatch(offset: number, limit: number, sinceTimestamp: number): Promise<Trade[]> {
    try {
        const response = await axios.get(
            `https://data-api.polymarket.com/activity?user=${TRADER_ADDRESS}&type=TRADE&limit=${limit}&offset=${offset}`,
            {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
            }
        );

        const trades: Trade[] = response.data.map((item: any) => ({
            id: item.id,
            timestamp: item.timestamp,
            market: item.slug || item.market,
            asset: item.asset,
            side: item.side,
            price: item.price,
            usdcSize: item.usdcSize,
            size: item.size,
            outcome: item.outcome || 'Unknown',
        }));

        return trades.filter((t) => t.timestamp >= sinceTimestamp);
    } catch (error: any) {
        // 400 错误表示没有更多数据了（offset 超出范围）
        if (error.response?.status === 400 || error.code === 'ERR_BAD_REQUEST') {
            return [];
        }
        // 其他错误继续抛出
        throw error;
    }
}

async function fetchTraderActivity(): Promise<Trade[]> {
    const fs = await import('fs');
    const path = await import('path');

    // Check cache first
    const cacheDir = path.join(process.cwd(), 'trader_data_cache');
    const today = new Date().toISOString().split('T')[0];
    const cacheFile = path.join(cacheDir, `${TRADER_ADDRESS}_${HISTORY_DAYS}d_${today}.json`);

    if (fs.existsSync(cacheFile)) {
        console.log(colors.cyan('📦 正在加载缓存的交易数据...'));
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        console.log(
            colors.green(`✓ 已从缓存加载 ${cached.trades.length} 笔交易 (${cached.name})`)
        );
        return cached.trades;
    }

    console.log(
        colors.cyan(
            `📊 正在获取交易员最近 ${HISTORY_DAYS} 天的交易数据（并行请求）...`
        )
    );

    // Calculate timestamp for history window
    const sinceTimestamp = Math.floor((Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000) / 1000);

    // First, get a sample to estimate total
    const firstBatch = await fetchBatch(0, 100, sinceTimestamp);

        // Check if trader has any recent activity
        if (firstBatch.length === 0) {
            console.log(colors.yellow(`⚠️  该交易员最近 ${HISTORY_DAYS} 天内没有交易记录。`));
            console.log(colors.yellow(`   交易员可能不活跃，或者交易次数少于预期。`));
            console.log(colors.yellow(`   建议：减少 HISTORY_DAYS 或选择其他交易员。\n`));

        // Try to check if there are any trades at all
        try {
            const response = await axios.get(
                `https://data-api.polymarket.com/activity?user=${TRADER_ADDRESS}&type=TRADE&limit=1`,
                {
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    },
                }
            );

                if (response.data && response.data.length > 0) {
                    const lastTrade = response.data[0];
                    const lastTradeDate = new Date(lastTrade.timestamp * 1000);
                    console.log(colors.cyan(`   最近一笔交易: ${lastTradeDate.toLocaleString('zh-CN')}`));
                    console.log(colors.gray(`   距今 ${Math.floor((Date.now() - lastTrade.timestamp * 1000) / (1000 * 60 * 60 * 24))} 天\n`));
                }
        } catch {
            // Ignore errors in this diagnostic check
        }

        return [];
    }

    let allTrades: Trade[] = [...firstBatch];
    let fetchCompleted = false;

    if (firstBatch.length === 100) {
        // Need to fetch more - do it in parallel batches
        const batchSize = 100;
        const maxParallel = 5; // 5 parallel requests at a time
        let offset = 100;

        while (allTrades.length < MAX_TRADES_LIMIT) {
            // Create batch of parallel requests
            const promises: Promise<Trade[]>[] = [];
            for (let i = 0; i < maxParallel; i++) {
                promises.push(fetchBatch(offset + i * batchSize, batchSize, sinceTimestamp));
            }

            let results: Trade[][];
            try {
                results = await Promise.all(promises);
            } catch (error: any) {
                // 400 错误表示没有更多数据了
                if (error.response?.status === 400 || error.code === 'ERR_BAD_REQUEST') {
                    console.log(colors.yellow('⚠️  API 返回 400 - 没有更多可用的交易数据'));
                    break;
                }
                throw error;
            }

            let addedCount = 0;

            for (const batch of results) {
                if (batch.length > 0) {
                    allTrades = allTrades.concat(batch);
                    addedCount += batch.length;
                }
                if (batch.length < batchSize) {
                    // Empty batch means no more data
                    fetchCompleted = true;
                    break;
                }
            }

            if (fetchCompleted || addedCount === 0) {
                break;
            }

            // Check limit
            if (allTrades.length >= MAX_TRADES_LIMIT) {
                console.log(
                    colors.yellow(
                        `⚠️  已达到交易数量上限 (${MAX_TRADES_LIMIT})，停止获取...`
                    )
                );
                allTrades = allTrades.slice(0, MAX_TRADES_LIMIT);
                break;
            }

            offset += maxParallel * batchSize;
            console.log(colors.gray(`  已获取 ${allTrades.length} 笔交易...`));
        }
    }

    const sortedTrades = allTrades.sort((a: Trade, b: Trade) => a.timestamp - b.timestamp);

    if (sortedTrades.length === 0) {
        console.log(colors.yellow(`⚠️  在最近 ${HISTORY_DAYS} 天内没有找到交易。\n`));
        return sortedTrades;
    }

    console.log(colors.green(`✓ 已获取最近 ${HISTORY_DAYS} 天的 ${sortedTrades.length} 笔交易`));

    // 保存到缓存
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    const cacheData = {
        name: `trader_${TRADER_ADDRESS.slice(0, 6)}_${HISTORY_DAYS}d_${today}`,
        traderAddress: TRADER_ADDRESS,
        fetchedAt: new Date().toISOString(),
        period: `${HISTORY_DAYS}_days`,
        totalTrades: sortedTrades.length,
        trades: sortedTrades,
    };

    fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2), 'utf8');
    console.log(colors.green(`✓ 已缓存到: ${cacheFile}\n`));

    return sortedTrades;
}

async function fetchTraderPositions(): Promise<Position[]> {
    try {
        console.log(colors.cyan('📈 正在获取交易员持仓...'));
        const response = await axios.get(
            `https://data-api.polymarket.com/positions?user=${TRADER_ADDRESS}`,
            {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
            }
        );

        console.log(colors.green(`✓ 已获取 ${response.data.length} 个持仓`));
        return response.data;
    } catch (error) {
        console.error(colors.red('获取交易员持仓失败：'), error);
        throw error;
    }
}

async function simulateCopyTrading(trades: Trade[]): Promise<SimulationResult> {
    console.log(colors.cyan('\n🎮 开始模拟...\n'));

    let yourCapital = STARTING_CAPITAL;
    let totalInvested = 0;
    let copiedTrades = 0;
    let skippedTrades = 0;

    const positions = new Map<string, SimulatedPosition>();

    for (const trade of trades) {
        // NEW LOGIC: Copy fixed percentage of trader's order size
        const baseOrderSize = trade.usdcSize * (COPY_PERCENTAGE / 100);
        let orderSize = baseOrderSize * MULTIPLIER;

        // Check if order meets minimum
        if (orderSize < MIN_ORDER_SIZE) {
            skippedTrades++;
            continue;
        }

        // Check if we have enough capital
        if (orderSize > yourCapital * 0.95) {
            orderSize = yourCapital * 0.95;
            if (orderSize < MIN_ORDER_SIZE) {
                skippedTrades++;
                continue;
            }
        }

        const positionKey = `${trade.asset}:${trade.outcome}`;

        if (trade.side === 'BUY') {
            // BUY trade
            const sharesReceived = orderSize / trade.price;

            if (!positions.has(positionKey)) {
                positions.set(positionKey, {
                    market: trade.market || trade.asset || 'Unknown market',
                    outcome: trade.outcome,
                    sharesHeld: 0, // Initialize shares
                    entryPrice: trade.price,
                    exitPrice: null,
                    invested: 0,
                    currentValue: 0,
                    pnl: 0,
                    closed: false,
                    trades: [],
                });
            }

            const pos = positions.get(positionKey)!;

            // Track shares properly
            pos.sharesHeld += sharesReceived;
            pos.invested += orderSize;
            pos.currentValue = pos.sharesHeld * trade.price;

            pos.trades.push({
                timestamp: trade.timestamp,
                side: 'BUY',
                price: trade.price,
                size: sharesReceived,
                usdcSize: orderSize,
                traderPercent: (trade.usdcSize / 100000) * 100, // Placeholder for display
                yourSize: orderSize,
            });

            yourCapital -= orderSize;
            totalInvested += orderSize;
            copiedTrades++;
        } else if (trade.side === 'SELL') {
            // SELL trade
            if (positions.has(positionKey)) {
                const pos = positions.get(positionKey)!;

                if (pos.sharesHeld <= 0) {
                    skippedTrades++;
                    continue;
                }

                // Calculate proportional sell based on trader's order
                const traderSellShares = trade.usdcSize / trade.price;
                const traderTotalShares = traderSellShares / 0.1; // Estimate (we don't know trader's exact position)
                const traderSellPercent = Math.min(traderSellShares / traderTotalShares, 1.0);

                // Sell same proportion of our shares
                const sharesToSell = Math.min(pos.sharesHeld * traderSellPercent, pos.sharesHeld);
                const sellAmount = sharesToSell * trade.price;

                pos.sharesHeld -= sharesToSell;
                pos.currentValue = pos.sharesHeld * trade.price;
                pos.exitPrice = trade.price;

                pos.trades.push({
                    timestamp: trade.timestamp,
                    side: 'SELL',
                    price: trade.price,
                    size: sharesToSell,
                    usdcSize: sellAmount,
                    traderPercent: traderSellPercent * 100,
                    yourSize: sellAmount,
                });

                yourCapital += sellAmount;

                if (pos.sharesHeld < 0.01) {
                    pos.closed = true;
                    // Calculate final P&L
                    const totalBought = pos.trades
                        .filter((t) => t.side === 'BUY')
                        .reduce((sum, t) => sum + t.usdcSize, 0);
                    const totalSold = pos.trades
                        .filter((t) => t.side === 'SELL')
                        .reduce((sum, t) => sum + t.usdcSize, 0);
                    pos.pnl = totalSold - totalBought;
                }

                copiedTrades++;
            } else {
                skippedTrades++;
            }
        }
    }

    // Calculate current values based on trader's current positions
    const traderPositions = await fetchTraderPositions();
    let totalCurrentValue = yourCapital;
    let unrealizedPnl = 0;
    let realizedPnl = 0;

    for (const [key, simPos] of positions.entries()) {
        if (!simPos.closed) {
            // Find matching trader position to get current value
            const assetId = key.split(':')[0];
            const traderPos = traderPositions.find((tp) => tp.asset === assetId);

            if (traderPos) {
                const currentPrice = traderPos.currentValue / traderPos.size;
                // Use tracked sharesHeld instead of recalculating
                simPos.currentValue = simPos.sharesHeld * currentPrice;
            }

            simPos.pnl = simPos.currentValue - simPos.invested;
            unrealizedPnl += simPos.pnl;
            totalCurrentValue += simPos.currentValue;
        } else {
            // Closed position - P&L already calculated
            realizedPnl += simPos.pnl;
        }
    }

    const currentCapital =
        yourCapital +
        Array.from(positions.values())
            .filter((p) => !p.closed)
            .reduce((sum, p) => sum + p.currentValue, 0);

    const totalPnl = currentCapital - STARTING_CAPITAL;
    const roi = (totalPnl / STARTING_CAPITAL) * 100;

    return {
        id: `sim_${TRADER_ADDRESS.slice(0, 8)}_${Date.now()}`,
        name: `FIXED_${TRADER_ADDRESS.slice(0, 6)}_${HISTORY_DAYS}d_copy${COPY_PERCENTAGE}pct`,
        logic: 'fixed_percentage',
        timestamp: Date.now(),
        traderAddress: TRADER_ADDRESS,
        startingCapital: STARTING_CAPITAL,
        currentCapital,
        totalTrades: trades.length,
        copiedTrades,
        skippedTrades,
        totalInvested,
        currentValue: totalCurrentValue,
        realizedPnl,
        unrealizedPnl,
        totalPnl,
        roi,
        positions: Array.from(positions.values()),
    };
}

function printReport(result: SimulationResult) {
    console.log('\n' + colors.cyan('═'.repeat(80)));
    console.log(colors.cyan('  📊 跟单交易模拟报告'));
    console.log(colors.cyan('═'.repeat(80)) + '\n');

    console.log('交易员:', colors.blue(result.traderAddress));
    console.log(
        '跟单比例:',
        colors.yellow(`${COPY_PERCENTAGE}%`),
        colors.gray('(按交易员订单金额)')
    );
    console.log('倍数:', colors.yellow(`${MULTIPLIER}x`));
    console.log();

    console.log(colors.bold('资金:'));
    console.log(`  起始资金: ${colors.green('$' + result.startingCapital.toFixed(2))}`);
    console.log(`  当前资金: ${colors.green('$' + result.currentCapital.toFixed(2))}`);
    console.log();

    console.log(colors.bold('表现:'));
    const pnlColor = result.totalPnl >= 0 ? colors.green : colors.red;
    const roiColor = result.roi >= 0 ? colors.green : colors.red;
    const pnlSign = result.totalPnl >= 0 ? '+' : '';
    const roiSign = result.roi >= 0 ? '+' : '';
    console.log(`  总盈亏:     ${pnlColor(pnlSign + '$' + result.totalPnl.toFixed(2))}`);
    console.log(`  收益率:     ${roiColor(roiSign + result.roi.toFixed(2) + '%')}`);
    console.log(
        `  已实现盈亏: ${result.realizedPnl >= 0 ? '+' : ''}$${result.realizedPnl.toFixed(2)}`
    );
    console.log(
        `  未实现盈亏: ${result.unrealizedPnl >= 0 ? '+' : ''}$${result.unrealizedPnl.toFixed(2)}`
    );
    console.log();

    console.log(colors.bold('交易统计:'));
    console.log(`  总交易数:  ${colors.cyan(String(result.totalTrades))}`);
    console.log(`  已复制:    ${colors.green(String(result.copiedTrades))}`);
    console.log(
        `  已跳过:    ${colors.yellow(String(result.skippedTrades))} (低于 $${MIN_ORDER_SIZE} 最低金额)`
    );
    console.log();

    const openPositions = result.positions.filter((p) => !p.closed);
    const closedPositions = result.positions.filter((p) => p.closed);

    console.log(colors.bold('未平仓位:'));
    console.log(`  数量: ${openPositions.length}\n`);

    openPositions.slice(0, 10).forEach((pos, i) => {
        const pnlStr =
            pos.pnl >= 0
                ? colors.green(`+$${pos.pnl.toFixed(2)}`)
                : colors.red(`-$${Math.abs(pos.pnl).toFixed(2)}`);
        const marketLabel = (pos.market || '未知市场').slice(0, 50);
        console.log(`  ${i + 1}. ${marketLabel}`);
        console.log(
            `     结果: ${pos.outcome} | 投入: $${pos.invested.toFixed(2)} | 当前价值: $${pos.currentValue.toFixed(2)} | 盈亏: ${pnlStr}`
        );
    });

    if (openPositions.length > 10) {
        console.log(colors.gray(`\n  ... 还有 ${openPositions.length - 10} 个仓位`));
    }

    if (closedPositions.length > 0) {
        console.log('\n' + colors.bold('已平仓位:'));
        console.log(`  数量: ${closedPositions.length}\n`);

        closedPositions.slice(0, 5).forEach((pos, i) => {
            const pnlStr =
                pos.pnl >= 0
                    ? colors.green(`+$${pos.pnl.toFixed(2)}`)
                    : colors.red(`-$${Math.abs(pos.pnl).toFixed(2)}`);
            const marketLabel = (pos.market || 'Unknown market').slice(0, 50);
            console.log(`  ${i + 1}. ${marketLabel}`);
            console.log(`     结果: ${pos.outcome} | 盈亏: ${pnlStr}`);
        });

        if (closedPositions.length > 5) {
            console.log(
                colors.gray(`\n  ... 还有 ${closedPositions.length - 5} 个已平仓位`)
            );
        }
    }

    console.log('\n' + colors.cyan('═'.repeat(80)) + '\n');
}

async function main() {
    console.log(colors.cyan('\n🚀 Polymarket 跟单交易模拟器\n'));
    console.log(colors.gray(`交易员: ${TRADER_ADDRESS}`));
    console.log(colors.gray(`起始资金: $${STARTING_CAPITAL}`));
    console.log(colors.gray(`跟单比例: ${COPY_PERCENTAGE}% (按交易员订单金额)`));
    console.log(colors.gray(`倍数: ${MULTIPLIER}x`));
    console.log(
        colors.gray(`历史窗口: ${HISTORY_DAYS} 天，最大交易数: ${MAX_TRADES_LIMIT}\n`)
    );

    try {
        const trades = await fetchTraderActivity();

        if (trades.length === 0) {
            console.log(colors.yellow('⚠️  没有交易数据可模拟。退出。\n'));
            process.exit(0);
        }

        const result = await simulateCopyTrading(trades);
        printReport(result);

        // 保存到 JSON 文件
        const fs = await import('fs');
        const path = await import('path');
        const resultsDir = path.join(process.cwd(), 'simulation_results');

        if (!fs.existsSync(resultsDir)) {
            fs.mkdirSync(resultsDir, { recursive: true });
        }

        const tag = (() => {
            const raw = process.env.SIM_RESULT_TAG;
            if (!raw) return '';
            return '_' + raw.trim().replace(/[^a-zA-Z0-9-_]+/g, '-');
        })();
        const filename = `fixed_logic_${TRADER_ADDRESS}_${HISTORY_DAYS}d_copy${COPY_PERCENTAGE}pct${tag}_${new Date().toISOString().split('T')[0]}.json`;
        const filepath = path.join(resultsDir, filename);

        fs.writeFileSync(filepath, JSON.stringify(result, null, 2), 'utf8');
        console.log(colors.green(`✓ 结果已保存到: ${filepath}\n`));

        console.log(colors.green('✓ 模拟完成！\n'));
    } catch (error) {
        console.error(colors.red('\n✗ 模拟失败：'), error);
        process.exit(1);
    }
}

main();
