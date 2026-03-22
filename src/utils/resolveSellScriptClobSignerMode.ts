import { ethers } from 'ethers';
import { SignatureType } from '@polymarket/order-utils';

/**
 * 卖出类脚本用的 CLOB 签名模式。
 * 若 PROXY_WALLET 与私钥地址相同，必须用 EOA(0)：否则误用 POLY_GNOSIS_SAFE 会导致 maker/signer 同址但按 Safe 校验 → invalid signature。
 * 仅当「私钥地址 ≠ 代理地址」且代理上有合约代码时，才按 Gnosis Safe 路径签名。
 */
export async function resolveSellScriptClobSignerMode(
    provider: ethers.providers.JsonRpcProvider,
    privateKey: string,
    proxyWallet: string
): Promise<{ signatureType: SignatureType; funderAddress?: string; modeLabel: string }> {
    const wallet = new ethers.Wallet(privateKey, provider);
    const walletAddr = (await wallet.getAddress()).toLowerCase();
    const proxyLower = proxyWallet.toLowerCase();

    if (walletAddr === proxyLower) {
        return {
            signatureType: SignatureType.EOA,
            funderAddress: undefined,
            modeLabel: 'EOA（私钥地址与 PROXY_WALLET 相同）',
        };
    }

    const code = await provider.getCode(proxyWallet);
    const hasBytecode = code !== '0x' && code !== '0x0';

    if (hasBytecode) {
        return {
            signatureType: SignatureType.POLY_GNOSIS_SAFE,
            funderAddress: proxyWallet,
            modeLabel: 'POLY_GNOSIS_SAFE（代理为合约且与私钥地址不同）',
        };
    }

    return {
        signatureType: SignatureType.EOA,
        funderAddress: undefined,
        modeLabel: 'EOA',
    };
}
