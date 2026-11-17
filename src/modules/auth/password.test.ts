import { describe, expect, it } from "vitest";
import { PASSWORD_MIN_LENGTH, assertPasswordPolicy, hashPassword, verifyPassword } from "./password";

describe("密码哈希（AC-11-10）", () => {
  it("哈希串自描述参数，且不含明文", async () => {
    const plain = "correct horse battery";
    const stored = await hashPassword(plain);

    expect(stored.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(stored.split("$")).toHaveLength(6);
    expect(stored).not.toContain(plain);
  });

  it("同一密码两次哈希不同（盐不同），但都能校验通过", async () => {
    const plain = "another strong password";
    const first = await hashPassword(plain);
    const second = await hashPassword(plain);

    expect(first).not.toBe(second);
    await expect(verifyPassword(plain, first)).resolves.toBe(true);
    await expect(verifyPassword(plain, second)).resolves.toBe(true);
  });

  it("错误密码不通过", async () => {
    const stored = await hashPassword("right password");
    await expect(verifyPassword("wrong password", stored)).resolves.toBe(false);
  });

  it("被篡改或格式错误的哈希不通过，且不抛错", async () => {
    const stored = await hashPassword("right password");
    const [, cost, block, parallel, salt, hash] = stored.split("$");

    await expect(verifyPassword("right password", `${hash}`)).resolves.toBe(false);
    await expect(verifyPassword("right password", "scrypt$16384$8$1$salt$")).resolves.toBe(false);
    await expect(
      verifyPassword("right password", `bcrypt$${cost}$${block}$${parallel}$${salt}$${hash}`),
    ).resolves.toBe(false);
    await expect(verifyPassword("right password", `${stored}extra`)).resolves.toBe(false);
  });

  it("scrypt 异步执行，不阻塞事件循环（返回 Promise）", () => {
    const result = hashPassword("async check password");
    expect(result).toBeInstanceOf(Promise);
    void result;
  });
});

describe("密码策略", () => {
  it(`少于 ${PASSWORD_MIN_LENGTH} 个字符被拒`, () => {
    expect(() => assertPasswordPolicy("someone@example.com", "short")).toThrowError(/密码/);
  });

  it("与邮箱相同被拒（不区分大小写）", () => {
    expect(() => assertPasswordPolicy("someone@example.com", "Someone@Example.com")).toThrowError(
      /邮箱/,
    );
  });

  it("合规密码通过", () => {
    expect(() => assertPasswordPolicy("someone@example.com", "long enough password")).not.toThrow();
  });
});
