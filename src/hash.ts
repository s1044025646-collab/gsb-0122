import crypto from 'node:crypto';

/**
 * 公开且确定的并列打破：对规范化字符串做 SHA-256，取前 16 个十六进制字符。
 * 相同输入永远得到相同结果；无随机源，测试可重放。
 */
export function deterministicTiebreak(parts: Array<string | number>): string {
  const canonical = parts.map((p) => String(p)).join('|');
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}
