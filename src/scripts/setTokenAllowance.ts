import { ethers } from 'ethers';
import { getContractConfig } from '@polymarket/clob-client';
import { ENV } from '../config/env';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const RPC_URL = ENV.RPC_URL;
const POLYGON_CHAIN_ID = 137;

const cfg = getContractConfig(POLYGON_CHAIN_ID);

/** CTF 需对「标准 CTF Exchange」与「Neg-risk Exchange」分别 setApprovalForAll，否则部分市场卖出会报 not enough allowance */
const CTF_SPENDERS: { label: string; address: string }[] = [
    { label: 'CTF Exchange', address: cfg.exchange },
    { label: 'Neg-risk Exchange', address: cfg.negRiskExchange },
];

const CTF_CONTRACT = cfg.conditionalTokens;

const CTF_ABI = [
    'function setApprovalForAll(address operator, bool approved) external',
    'function isApprovedForAll(address account, address operator) view returns (bool)',
];

async function setTokenAllowance() {
    console.log('🔑 Setting Token Allowance for Polymarket Trading');
    console.log('═══════════════════════════════════════════════\n');

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    console.log(`📍 Token holder (PROXY_WALLET): ${PROXY_WALLET}`);
    console.log(`📍 CTF Contract: ${CTF_CONTRACT}`);
    for (const s of CTF_SPENDERS) {
        console.log(`📍 ${s.label}: ${s.address}`);
    }
    console.log('');

    try {
        const ctfContract = new ethers.Contract(CTF_CONTRACT, CTF_ABI, wallet);

        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice
            ? feeData.gasPrice.mul(150).div(100)
            : ethers.utils.parseUnits('50', 'gwei');

        for (const spender of CTF_SPENDERS) {
            console.log(`🔍 Checking approval for ${spender.label}...`);
            const isApproved = await ctfContract.isApprovedForAll(PROXY_WALLET, spender.address);

            if (isApproved) {
                console.log(`✅ Already approved for ${spender.label}\n`);
                continue;
            }

            console.log(`⚠️  NOT approved for ${spender.label} — sending setApprovalForAll...\n`);

            const tx = await ctfContract.setApprovalForAll(spender.address, true, {
                gasPrice,
                gasLimit: 100000,
            });

            console.log(`⏳ Transaction sent: ${tx.hash}`);
            const receipt = await tx.wait();

            if (receipt.status !== 1) {
                console.log(`❌ Transaction failed for ${spender.label}`);
                return;
            }

            const ok = await ctfContract.isApprovedForAll(PROXY_WALLET, spender.address);
            console.log(ok ? `✅ Verified: ${spender.label}` : `❌ Verification failed: ${spender.label}`);
            console.log(`🔗 https://polygonscan.com/tx/${tx.hash}\n`);
        }

        console.log('✅ CTF outcome-token approvals complete. You can run sell scripts again.\n');
    } catch (error: any) {
        console.error('❌ Error:', error.message);
        if (error.code === 'INSUFFICIENT_FUNDS') {
            console.log('\n⚠️  You need MATIC for gas fees on Polygon!');
        }
    }
}

setTokenAllowance()
    .then(() => {
        console.log('✅ Done!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    });
