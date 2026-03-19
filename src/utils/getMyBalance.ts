import { ethers } from 'ethers';
import { ENV } from '../config/env';

const RPC_URL = ENV.RPC_URL;
const USDC_CONTRACT_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;

const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

// Exponential backoff delays: 3s, 5s, 10s, 20s, 30s (max), then cycle back
const RETRY_DELAYS = [3000, 5000, 10000, 20000, 30000];

/**
 * Get USDC balance with exponential backoff retry
 * On RPC errors, retries with increasing delays (3s -> 5s -> 10s -> 20s -> 30s max)
 * After max delay, cycles back to 3s
 */
const getMyBalance = async (address: string): Promise<number> => {
    const rpcProvider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const usdcContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, rpcProvider);

    let delayIndex = 0;

    while (true) {
        try {
            const balance_usdc = await usdcContract.balanceOf(address);
            const balance_usdc_real = ethers.utils.formatUnits(balance_usdc, 6);
            return parseFloat(balance_usdc_real);
        } catch (error: any) {
            const isRpcError = error?.code === 'SERVER_ERROR' || error?.code === 'CALL_EXCEPTION';
            const errorMsg = error?.reason || error?.message || String(error);
            const currentDelay = RETRY_DELAYS[delayIndex];

            if (isRpcError) {
                console.error(`[getMyBalance] RPC error: ${errorMsg}`);
                console.error(`[getMyBalance] Retrying in ${currentDelay / 1000}s... (delay tier ${delayIndex + 1}/${RETRY_DELAYS.length})`);

                await new Promise((resolve) => setTimeout(resolve, currentDelay));

                // Move to next delay tier, cycle back after max
                delayIndex = (delayIndex + 1) % RETRY_DELAYS.length;
            } else {
                // Non-RPC error, log and return 0
                console.error(`[getMyBalance] Non-RPC error: ${errorMsg}`);
                return 0;
            }
        }
    }
};

export default getMyBalance;
