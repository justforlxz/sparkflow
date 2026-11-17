import { describe, expect, it, vi } from "vitest";
import {
  decryptSecret,
  deriveSecretKey,
  describeSecret,
  encryptSecret,
  maskSecret,
} from "./crypto";

const AUTH_SECRET = "local-test-auth-secret-0123456789abcdef";
const KEY = deriveSecretKey(AUTH_SECRET);
const TEST_API_KEY = "sk-local-test-key-0000123456789";

describe("密钥加密与掩码", () => {
  it("加密后能解回原文，且密文里不含原文", () => {
    const encrypted = encryptSecret(TEST_API_KEY, KEY);

    expect(decryptSecret(encrypted, KEY)).toBe(TEST_API_KEY);
    expect(encrypted).not.toContain(TEST_API_KEY);
    expect(encrypted.startsWith("v1:")).toBe(true);
  });

  it("同一明文两次加密得到不同密文（随机 IV）", () => {
    expect(encryptSecret(TEST_API_KEY, KEY)).not.toBe(encryptSecret(TEST_API_KEY, KEY));
  });

  it("密钥变了就解不开（AUTH_SECRET 变更后旧密文作废）", () => {
    const encrypted = encryptSecret(TEST_API_KEY, KEY);
    const otherKey = deriveSecretKey("sk-local-test-other-secret-zyxwvutsrqponmlk");

    expect(() => decryptSecret(encrypted, otherKey)).toThrow();
  });

  it("不同用途派生出不同子密钥", () => {
    expect(deriveSecretKey(AUTH_SECRET).equals(deriveSecretKey(AUTH_SECRET, "other"))).toBe(false);
  });

  it("掩码只保留末 4 位，过短的密钥整体隐去", () => {
    expect(maskSecret(TEST_API_KEY)).toBe(`••••${TEST_API_KEY.slice(-4)}`);
    expect(maskSecret(TEST_API_KEY)).toHaveLength(8);
    expect(maskSecret("short")).toBe("••••");
    expect(maskSecret(TEST_API_KEY)).not.toContain(TEST_API_KEY);
  });

  it("describeSecret 只给掩码与 hasApiKey，不给明文（MUST 1）", () => {
    const description = describeSecret(encryptSecret(TEST_API_KEY, KEY), KEY);

    expect(description).toEqual({ mask: `••••${TEST_API_KEY.slice(-4)}`, hasApiKey: true });
    expect(JSON.stringify(description)).not.toContain(TEST_API_KEY);
  });

  it("密文损坏时 describeSecret 退化为纯掩码，不抛错", () => {
    const description = describeSecret("v1:bad:bad:bad", KEY);

    expect(description).toEqual({ mask: "••••", hasApiKey: true });
  });

  it("没有 AUTH_SECRET 时加密抛错并指出变量名（AC-03-8）", async () => {
    const saved = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    vi.resetModules();

    try {
      const fresh = await import("./crypto");
      expect(() => fresh.encryptSecret(TEST_API_KEY)).toThrowError(/AUTH_SECRET/);
    } finally {
      if (saved !== undefined) process.env.AUTH_SECRET = saved;
    }
  });
});
