/**
 * 网关 API Key 的加密、解密与掩码（docs/prd/02-model-gateway.md MUST 1、7）。
 *
 * - 密钥用 `AUTH_SECRET` 经 HKDF 派生的独立子密钥（informational string 区分用途），
 *   不复用会话签名密钥。
 * - 算法 AES-256-GCM，密文格式 `v1:<iv>:<tag>:<ciphertext>`（base64url），带版本前缀便于将来轮换。
 * - 对外只给掩码：`••••` + 末 4 位；明文只在服务端发请求时解密。
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { getEnv } from "./env";
import { logger } from "./logger";

const CIPHER = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const FORMAT_VERSION = "v1";

/** 派生用途串：同一个 AUTH_SECRET 在不同用途下得到不同子密钥。 */
export const SECRET_KEY_INFO = "sparkflow/gateway-api-key";
const HKDF_SALT = "sparkflow";

export function deriveSecretKey(authSecret: string, info: string = SECRET_KEY_INFO): Buffer {
  return Buffer.from(hkdfSync("sha256", authSecret, HKDF_SALT, info, KEY_BYTES));
}

let cachedKey: Buffer | undefined;

/** 从环境变量取派生密钥；`AUTH_SECRET` 缺失时由 `getEnv()` 报错并指出变量名（AC-03-8）。 */
export function secretKey(): Buffer {
  if (!cachedKey) cachedKey = deriveSecretKey(getEnv().AUTH_SECRET);
  return cachedKey;
}

/** 仅供测试：清掉缓存的派生密钥，让 `process.env` 的改动生效。 */
export function resetSecretKeyCache(): void {
  cachedKey = undefined;
}

export function encryptSecret(plainText: string, key: Buffer = secretKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    FORMAT_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

/** 解密失败（密文被改、AUTH_SECRET 变了）直接抛错，不返回半成品。 */
export function decryptSecret(payload: string, key: Buffer = secretKey()): string {
  const [version, iv, tag, ciphertext] = payload.split(":");
  if (version !== FORMAT_VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error("密文格式不正确");
  }

  const decipher = createDecipheriv(CIPHER, key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** 掩码：只保留末 4 位；过短的密钥整体隐去，避免掩码本身就是原文。 */
export function maskSecret(plainText: string): string {
  if (plainText.length <= 8) return "••••";
  return `••••${plainText.slice(-4)}`;
}

export interface SecretDescription {
  mask: string;
  hasApiKey: boolean;
}

/**
 * 列表与详情接口用的描述：有密钥就是 `hasApiKey: true` + 掩码，永远不返回明文。
 * 无法解密（AUTH_SECRET 变更）时也照旧返回 `hasApiKey: true`，掩码退化为 `••••` 并记一条告警。
 */
export function describeSecret(encrypted: string, key: Buffer = secretKey()): SecretDescription {
  try {
    return { mask: maskSecret(decryptSecret(encrypted, key)), hasApiKey: true };
  } catch (error) {
    logger.warn("网关密钥无法解密，请重新填写", { error });
    return { mask: "••••", hasApiKey: true };
  }
}
