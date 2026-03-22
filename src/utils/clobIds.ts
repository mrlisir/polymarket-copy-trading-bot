/**
 * CLOB / Gamma 的 token_id 为长整数字符串，日志换行或手工编辑 .env 可能夹入空白；
 * axios 若把大整数当 number 解析会丢精度——入库前应尽量保持 API 原始字符串并做规范化。
 */
export const normalizeClobAssetId = (raw: unknown): string =>
    String(raw ?? '')
        .replace(/\s+/g, '')
        .trim();

/**
 * Data API / 中间层若把 token_id 当 JSON number 解析，大整数会丢精度。
 * 优先保证字符串路径；若已是 number 则打告警并仍做规范化（可能已错误）。
 */
export const safeClobAssetFromApi = (raw: unknown, ctx?: string): string => {
    if (raw == null) return '';
    if (typeof raw === 'number') {
        const suffix = ctx ? ` (${ctx})` : '';
        if (!Number.isInteger(raw) || Math.abs(raw) > Number.MAX_SAFE_INTEGER) {
            console.warn(
                `[clobIds] token_id 被解析为不精确或非安全整数 number，可能已损坏${suffix}`
            );
        } else {
            console.warn(
                `[clobIds] token_id 被解析为 number（大整数应用字符串）${suffix}`
            );
        }
        return normalizeClobAssetId(String(raw));
    }
    return normalizeClobAssetId(raw);
};
