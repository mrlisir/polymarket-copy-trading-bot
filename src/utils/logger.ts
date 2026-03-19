import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

class Logger {
    private static logsDir = path.join(process.cwd(), 'logs');
    private static currentLogFile = '';

    private static getLogFileName(): string {
        const date = new Date().toISOString().split('T')[0];
        return path.join(this.logsDir, `bot-${date}.log`);
    }

    private static ensureLogsDir(): void {
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
    }

    private static writeToFile(message: string): void {
        try {
            this.ensureLogsDir();
            const logFile = this.getLogFileName();
            const timestamp = new Date().toISOString();
            const logEntry = `[${timestamp}] ${message}\n`;
            fs.appendFileSync(logFile, logEntry, 'utf8');
        } catch {
            // Silently fail to avoid infinite loops
        }
    }

    private static stripAnsi(str: string): string {
        return str.replace(/\u001b\[\d+m/g, '');
    }

    private static formatAddress(address: string): string {
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    private static maskAddress(address: string): string {
        return `${address.slice(0, 6)}${'*'.repeat(34)}${address.slice(-4)}`;
    }

    static header(title: string) {
        console.log('\n' + chalk.cyan('━'.repeat(70)));
        console.log(chalk.cyan.bold(`  ${title}`));
        console.log(chalk.cyan('━'.repeat(70)) + '\n');
        this.writeToFile(`HEADER: ${title}`);
    }

    static info(message: string) {
        console.log(chalk.blue('ℹ'), message);
        this.writeToFile(`INFO: ${message}`);
    }

    static success(message: string) {
        console.log(chalk.green('✓'), message);
        this.writeToFile(`SUCCESS: ${message}`);
    }

    static warning(message: string) {
        console.log(chalk.yellow('⚠'), message);
        this.writeToFile(`WARNING: ${message}`);
    }

    static error(message: string) {
        console.log(chalk.red('✗'), message);
        this.writeToFile(`ERROR: ${message}`);
    }

    static trade(traderAddress: string, action: string, details: any) {
        console.log('\n' + chalk.magenta('─'.repeat(70)));
        console.log(chalk.magenta.bold('📊 检测到新交易'));
        console.log(chalk.gray(`交易员: ${this.formatAddress(traderAddress)}`));
        console.log(chalk.gray(`操作: ${chalk.white.bold(action)}`));
        if (details.asset) {
            console.log(chalk.gray(`资产:  ${this.formatAddress(details.asset)}`));
        }
        if (details.side) {
            const sideColor = details.side === 'BUY' ? chalk.green : chalk.red;
            const sideText = details.side === 'BUY' ? '买入 (BUY)' : '卖出 (SELL)';
            console.log(chalk.gray(`方向:   ${sideColor.bold(sideText)}`));
        }
        if (details.amount) {
            console.log(chalk.gray(`金额: ${chalk.yellow(`$${details.amount}`)}`));
        }
        if (details.price) {
            console.log(chalk.gray(`价格:  ${chalk.cyan(details.price)}`));
        }
        if (details.eventSlug || details.slug) {
            const slug = details.eventSlug || details.slug;
            const marketUrl = `https://polymarket.com/event/${slug}`;
            console.log(chalk.gray(`市场: ${chalk.blue.underline(marketUrl)}`));
        }
        if (details.transactionHash) {
            const txUrl = `https://polygonscan.com/tx/${details.transactionHash}`;
            console.log(chalk.gray(`交易: ${chalk.blue.underline(txUrl)}`));
        }
        console.log(chalk.magenta('─'.repeat(70)) + '\n');

        let tradeLog = `TRADE: ${this.formatAddress(traderAddress)} - ${action}`;
        if (details.side) tradeLog += ` | Side: ${details.side}`;
        if (details.amount) tradeLog += ` | Amount: $${details.amount}`;
        if (details.price) tradeLog += ` | Price: ${details.price}`;
        if (details.title) tradeLog += ` | Market: ${details.title}`;
        if (details.transactionHash) tradeLog += ` | TX: ${details.transactionHash}`;
        this.writeToFile(tradeLog);
    }

    static balance(myBalance: number, traderBalance: number, traderAddress: string) {
        console.log(chalk.gray('💰 资金状况 (USDC + 仓位):'));
        console.log(
            chalk.gray(`  您的总资金:     ${chalk.green.bold(`$${myBalance.toFixed(2)}`)}`)
        );
        console.log(
            chalk.gray(
                `  交易员总资金: ${chalk.blue.bold(`$${traderBalance.toFixed(2)}`)} (${this.formatAddress(traderAddress)})`
            )
        );
    }

    static orderResult(success: boolean, message: string) {
        if (success) {
            console.log(chalk.green('✓'), chalk.green.bold('订单执行成功:'), message);
            this.writeToFile(`ORDER SUCCESS: ${message}`);
        } else {
            console.log(chalk.red('✗'), chalk.red.bold('订单执行失败:'), message);
            this.writeToFile(`ORDER FAILED: ${message}`);
        }
    }

    static monitoring(traderCount: number) {
        const timestamp = new Date().toLocaleTimeString();
        console.log(
            chalk.dim(`[${timestamp}]`),
            chalk.cyan('👁️  监控中'),
            chalk.yellow(`${traderCount} 个交易员`)
        );
    }

    static startup(traders: string[], myWallet: string) {
        console.log('\n');
        console.log(chalk.cyan('  ____       _        ____                 '));
        console.log(chalk.cyan(' |  _ \\ ___ | |_   _ / ___|___  _ __  _   _ '));
        console.log(chalk.cyan.bold(" | |_) / _ \\| | | | | |   / _ \\| '_ \\| | | |"));
        console.log(chalk.magenta.bold(' |  __/ (_) | | |_| | |__| (_) | |_) | |_| |'));
        console.log(chalk.magenta(' |_|   \\___/|_|\\__, |\\____\\___/| .__/  \\__, |'));
        console.log(chalk.magenta('               |___/            |_|    |___/ '));
        console.log(chalk.gray('               复制高手，自动化交易，躺赢成功\n'));

        console.log(chalk.cyan('━'.repeat(70)));
        console.log(chalk.cyan('📊 正在跟踪的交易员:'));
        traders.forEach((address, index) => {
            console.log(chalk.gray(`   ${index + 1}. ${address}`));
        });
        console.log(chalk.cyan(`\n💼 您的钱包:`));
        console.log(chalk.gray(`   ${this.maskAddress(myWallet)}\n`));
    }

    static dbConnection(traders: string[], counts: number[]) {
        console.log('\n' + chalk.cyan('📦 数据库状态:'));
        traders.forEach((address, index) => {
            const countStr = chalk.yellow(`${counts[index]} 条交易记录`);
            console.log(chalk.gray(`   ${this.formatAddress(address)}: ${countStr}`));
        });
        console.log('');
    }

    static separator() {
        console.log(chalk.dim('─'.repeat(70)));
    }

    private static spinnerFrames = ['⏳', '⌛', '⏳'];
    private static spinnerIndex = 0;

    static waiting(traderCount: number, extraInfo?: string) {
        const timestamp = new Date().toLocaleTimeString();
        const spinner = this.spinnerFrames[this.spinnerIndex % this.spinnerFrames.length];
        this.spinnerIndex++;

        const message = extraInfo
            ? `${spinner} 等待交易员(${traderCount}位)的新交易... (${extraInfo})`
            : `${spinner} 等待交易员(${traderCount}位)的新交易...`;

        process.stdout.write(chalk.dim(`\r[${timestamp}] `) + chalk.cyan(message) + '  ');
    }

    static clearLine() {
        process.stdout.write('\r' + ' '.repeat(100) + '\r');
    }

    static myPositions(
        wallet: string,
        count: number,
        topPositions: any[],
        overallPnl: number,
        totalValue: number,
        initialValue: number,
        currentBalance: number
    ) {
        console.log('\n' + chalk.magenta.bold('💼 您的仓位'));
        console.log(chalk.gray(`   钱包: ${this.formatAddress(wallet)}`));
        console.log('');

        const balanceStr = chalk.yellow.bold(`$${currentBalance.toFixed(2)}`);
        const totalPortfolio = currentBalance + totalValue;
        const portfolioStr = chalk.cyan.bold(`$${totalPortfolio.toFixed(2)}`);

        console.log(chalk.gray(`   💰 可用现金:      ${balanceStr}`));
        console.log(chalk.gray(`   📊 总资产:        ${portfolioStr}`));

        if (count === 0) {
            console.log(chalk.gray(`\n   暂无持仓`));
        } else {
            const countStr = chalk.green(`${count} 个仓位`);
            const pnlColor = overallPnl >= 0 ? chalk.green : chalk.red;
            const pnlSign = overallPnl >= 0 ? '+' : '';
            const profitStr = pnlColor.bold(`${pnlSign}${overallPnl.toFixed(1)}%`);
            const valueStr = chalk.cyan(`$${totalValue.toFixed(2)}`);
            const initialStr = chalk.gray(`$${initialValue.toFixed(2)}`);

            console.log('');
            console.log(chalk.gray(`   📈 持仓中仓位:   ${countStr}`));
            console.log(chalk.gray(`      投入金额:       ${initialStr}`));
            console.log(chalk.gray(`      当前价值:       ${valueStr}`));
            console.log(chalk.gray(`      盈亏:           ${profitStr}`));

            if (topPositions.length > 0) {
                console.log(chalk.gray(`\n   🔝 重点仓位:`));
                topPositions.forEach((pos: any) => {
                    const pnlColor = pos.percentPnl >= 0 ? chalk.green : chalk.red;
                    const pnlSign = pos.percentPnl >= 0 ? '+' : '';
                    const avgPrice = pos.avgPrice || 0;
                    const curPrice = pos.curPrice || 0;
                    console.log(
                        chalk.gray(
                            `      • ${pos.outcome} - ${pos.title.slice(0, 45)}${pos.title.length > 45 ? '...' : ''}`
                        )
                    );
                    console.log(
                        chalk.gray(
                            `        价值: ${chalk.cyan(`$${pos.currentValue.toFixed(2)}`)} | 盈亏: ${pnlColor(`${pnlSign}${pos.percentPnl.toFixed(1)}%`)}`
                        )
                    );
                    console.log(
                        chalk.gray(
                            `        买入价: ${chalk.yellow(`${(avgPrice * 100).toFixed(1)}¢`)} | 当前价: ${chalk.yellow(`${(curPrice * 100).toFixed(1)}¢`)}`
                        )
                    );
                });
            }
        }
        console.log('');
    }

    static tradersPositions(
        traders: string[],
        positionCounts: number[],
        positionDetails?: any[][],
        profitabilities?: number[]
    ) {
        console.log('\n' + chalk.cyan('📈 正在跟单的交易员'));
        traders.forEach((address, index) => {
            const count = positionCounts[index];
            const countStr =
                count > 0
                    ? chalk.green(`${count} 个仓位`)
                    : chalk.gray('0 个仓位');

            let profitStr = '';
            if (profitabilities && profitabilities[index] !== undefined && count > 0) {
                const pnl = profitabilities[index];
                const pnlColor = pnl >= 0 ? chalk.green : chalk.red;
                const pnlSign = pnl >= 0 ? '+' : '';
                profitStr = ` | ${pnlColor.bold(`${pnlSign}${pnl.toFixed(1)}%`)}`;
            }

            console.log(chalk.gray(`   ${this.formatAddress(address)}: ${countStr}${profitStr}`));

            if (positionDetails && positionDetails[index] && positionDetails[index].length > 0) {
                positionDetails[index].forEach((pos: any) => {
                    const pnlColor = pos.percentPnl >= 0 ? chalk.green : chalk.red;
                    const pnlSign = pos.percentPnl >= 0 ? '+' : '';
                    const avgPrice = pos.avgPrice || 0;
                    const curPrice = pos.curPrice || 0;
                    console.log(
                        chalk.gray(
                            `      • ${pos.outcome} - ${pos.title.slice(0, 40)}${pos.title.length > 40 ? '...' : ''}`
                        )
                    );
                    console.log(
                        chalk.gray(
                            `        价值: ${chalk.cyan(`$${pos.currentValue.toFixed(2)}`)} | 盈亏: ${pnlColor(`${pnlSign}${pos.percentPnl.toFixed(1)}%`)}`
                        )
                    );
                    console.log(
                        chalk.gray(
                            `        买入价: ${chalk.yellow(`${(avgPrice * 100).toFixed(1)}¢`)} | 当前价: ${chalk.yellow(`${(curPrice * 100).toFixed(1)}¢`)}`
                        )
                    );
                });
            }
        });
        console.log('');
    }
}

export default Logger;
