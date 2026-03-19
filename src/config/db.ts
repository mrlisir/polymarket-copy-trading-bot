import mongoose from 'mongoose';
import { ENV } from './env';
import chalk from 'chalk';

const uri = ENV.MONGO_URI || 'mongodb://localhost:27017/polymarket_copytrading';

const connectDB = async () => {
    try {
        await mongoose.connect(uri);
        console.log(chalk.green('✓'), 'MongoDB 已连接');
    } catch (error) {
        console.log(chalk.red('✗'), 'MongoDB 连接失败:', error);
        process.exit(1);
    }
};

/**
 * 优雅关闭数据库连接
 */
export const closeDB = async (): Promise<void> => {
    try {
        await mongoose.connection.close();
        console.log(chalk.green('✓'), 'MongoDB 连接已关闭');
    } catch (error) {
        console.log(chalk.red('✗'), '关闭 MongoDB 连接时出错:', error);
    }
};

export default connectDB;
