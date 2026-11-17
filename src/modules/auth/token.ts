/** 会话令牌：cookie 里放 32 字节随机值的 base64url，库里只存它的 SHA-256。 */
import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;

export function createSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
