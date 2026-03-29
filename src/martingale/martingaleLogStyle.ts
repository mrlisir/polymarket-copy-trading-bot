/**
 * @author li.mingfeng
 * 马丁格尔控制台：ANSI 颜色 + 少量图标增强（写文件前由 Logger 剥码）。
 */

import chalk from 'chalk';

const colorsOff = (): boolean =>
    process.env.MARTINGALE_LOG_COLOR === 'false' || process.env.NO_COLOR !== undefined;

const highlightSeriesTier = (m: string): string => {
    return chalk.bgMagenta.bold.white(` ${m} `);
};

/** 押边方向与「偏高为 X」在紧凑/详日志中提亮，便于扫一眼对齐趋势 */
const highlightBetSideAndBiasLabels = (s: string): string => {
    let o = s;
    o = o.replace(/押边:\s*([^\|（]+?)(?=\s*[\|（]|$)/g, (_full, label: string) => {
        return `押边: ${chalk.bold.yellowBright(label.trim())}`;
    });
    o = o.replace(/押边\s+([^\s·（]+)/g, (_full, label: string) => {
        return `押边 ${chalk.bold.yellowBright(label)}`;
    });
    o = o.replace(/偏高为\s+([^，,）\)\s\n\r]+)/g, (_full, label: string) => {
        return `偏高为 ${chalk.bold.cyanBright(String(label).trim())}`;
    });
    return o;
};

const styleRest = (rest: string): string => {
    let out = rest;
    out = out.replace(/本序列档\d+\/\d+\(2\^\d+×基\)/g, (m) => highlightSeriesTier(m));
    out = out.replace(/\[([A-Z]+):(5m|15m)\]/g, (m) => chalk.bold.cyan(m));
    out = out.replace(/\[回测[^\]]+\]/g, (m) => chalk.bold.magenta(m));
    out = out.replace(/倒计时[^\|]+/g, (m) => chalk.bold.yellow(m));
    out = out.replace(/累计已实现\+[\d.]+U/g, (m) => chalk.greenBright(m));
    out = out.replace(/累计已实现-[\d.]+U/g, (m) => chalk.redBright(m));
    out = out.replace(/浮\+[\d.]+U/g, (m) => chalk.green(m));
    out = out.replace(/浮-[\d.]+U/g, (m) => chalk.red(m));
    out = out.replace(/下一档\d+\/\d+/g, (m) => chalk.blueBright(m));
    out = out.replace(/本局赚[^|]*/g, (m) => chalk.greenBright(m));
    out = out.replace(/本局亏[^|]*/g, (m) => chalk.redBright(m));
    out = highlightBetSideAndBiasLabels(out);
    return out;
};

const styleHead = (head: string, line: string): string => {
    const t = line.trimStart();
    if (t.startsWith('⏳')) {
        return chalk.cyan.bold(head);
    }
    if (t.startsWith('✓')) {
        return chalk.green.bold(head);
    }
    if (t.startsWith('✗')) {
        return chalk.red.bold(head);
    }
    if (t.startsWith('◇')) {
        return chalk.magenta.bold(`🚀 ${head}`);
    }
    if (t.startsWith('⚠')) {
        return chalk.yellow.bold(head);
    }
    if (t.startsWith('—')) {
        return chalk.gray.bold(`⏸ ${head}`);
    }
    return head;
};

/**
 * 单行马丁日志上色（保留 OSC8 盘口链）。
 */
export const styleMartingaleConsoleLine = (line: string): string => {
    if (!line || colorsOff()) {
        return line;
    }
    if (line.startsWith('────────')) {
        return chalk.dim.cyan('📋 ' + line);
    }
    if (line.includes('live 模式需要传入')) {
        return chalk.yellow('⚡ ' + line);
    }

    const firstPipe = line.indexOf('|');
    if (firstPipe < 0) {
        let one = line;
        one = one.replace(/本序列档\d+\/\d+\(2\^\d+×基\)/g, (m) => highlightSeriesTier(m));
        one = one.replace(/\[([A-Z]+):(5m|15m)\]/g, (m) => chalk.bold.cyan(m));
        one = one.replace(/\[回测[^\]]+\]/g, (m) => chalk.bold.magenta(m));
        one = highlightBetSideAndBiasLabels(one);
        const t = one.trimStart();
        if (t.startsWith('✓')) {
            return chalk.green(one);
        }
        if (t.startsWith('⚠')) {
            return chalk.yellow(one);
        }
        if (t.startsWith('—')) {
            return chalk.gray('⏸ ' + one);
        }
        return one;
    }

    const head = line.slice(0, firstPipe);
    const rest = line.slice(firstPipe);
    const styledHead = styleHead(head, line);
    const styledRest = styleRest(rest);
    return styledHead + styledRest;
};

/** 多行块（详日志）逐行上色 */
export const styleMartingaleConsoleBlock = (text: string): string => {
    return text.split('\n').map((ln) => styleMartingaleConsoleLine(ln)).join('\n');
};
