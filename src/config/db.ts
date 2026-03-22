import mongoose from 'mongoose';
import { ENV } from './env';
import chalk from 'chalk';

const uri = ENV.MONGO_URI || 'mongodb://localhost:27017/polymarket_copytrading';

const connectDB = async () => {
    await mongoose.connect(uri);
    console.log(chalk.green('✓'), 'MongoDB 已连接');
};

/**
 * 优雅关闭数据库连接
 */
export const closeDB = async (): Promise<void> => {
    try {
        if (mongoose.connection.readyState !== 0) {
            await mongoose.connection.close();
            console.log(chalk.green('✓'), 'MongoDB 连接已关闭');
        }
    } catch (error) {
        console.log(chalk.red('✗'), '关闭 MongoDB 连接时出错:', error);
    }
};

export default connectDB;
