/**
 * 密码哈希：Node 内置 `scrypt`（异步，避免阻塞事件循环），哈希串自描述参数，便于将来提高强度。
 * 格式：`scrypt$N$r$p$salt$hash`
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/errors";

export const PASSWORD_MIN_LENGTH = 10;

const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

function deriveKey(
  plain: string,
  salt: string,
  keyLength: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(plain, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString("base64url");
  const derived = await deriveKey(plain, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
  });
  return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELIZATION}$${salt}$${derived.toString("base64url")}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, costRaw, blockRaw, parallelRaw, salt, hash] = parts;
  const N = Number(costRaw);
  const r = Number(blockRaw);
  const p = Number(parallelRaw);
  if (![N, r, p].every((value) => Number.isInteger(value) && value > 0)) return false;

  const expected = Buffer.from(hash ?? "", "base64url");
  if (expected.length === 0) return false;

  const derived = await deriveKey(plain, salt ?? "", expected.length, { N, r, p });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** 密码策略：至少 10 个字符，且不能与邮箱相同（不区分大小写）。 */
export function assertPasswordPolicy(email: string, password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw AppError.validationFailed(`密码至少 ${PASSWORD_MIN_LENGTH} 个字符`, {
      code: "WEAK_PASSWORD",
    });
  }
  if (password.trim().toLowerCase() === email.trim().toLowerCase()) {
    throw AppError.validationFailed("密码不能与邮箱相同", { code: "WEAK_PASSWORD" });
  }
}
