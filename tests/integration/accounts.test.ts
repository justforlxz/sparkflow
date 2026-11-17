import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { getDb } from "@/lib/db";
import { hashSessionToken } from "@/modules/auth/token";
import { login, registerFirstUser, resetPassword } from "@/modules/auth/service";

const EMAIL = "owner@example.com";
const PASSWORD = "first-account-password";
const NEW_PASSWORD = "rotated-account-password";
const USER_AGENT = "vitest";

async function clearAccounts(): Promise<void> {
  const db = getDb();
  await db.session.deleteMany();
  await db.user.deleteMany();
}

beforeAll(clearAccounts);
afterAll(clearAccounts);

describe("账号与会话（集成）", () => {
  test("空库可以注册第一个账号，并顺手拿到可用会话", async () => {
    const grant = await registerFirstUser(
      { email: EMAIL, name: "站长", password: PASSWORD },
      { userAgent: USER_AGENT },
    );

    expect(grant.user).toMatchObject({ email: EMAIL, name: "站长" });
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("AC-11-2 已存在账号时再次注册被拒，用户数不变（403）", async () => {
    await expect(
      registerFirstUser(
        { email: "second@example.com", name: "第二人", password: PASSWORD },
        { userAgent: USER_AGENT },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    expect(await getDb().user.count()).toBe(1);
  });

  test("AC-11-3 正确密码登录成功，错误密码返回统一文案", async () => {
    const grant = await login({ email: EMAIL, password: PASSWORD, ip: "10.0.0.1" }, { userAgent: USER_AGENT });
    expect(grant.user.email).toBe(EMAIL);

    await expect(
      login({ email: EMAIL, password: "wrong-password-here", ip: "10.0.0.2" }, { userAgent: USER_AGENT }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "邮箱或密码不正确" });

    await expect(
      login({ email: "nobody@example.com", password: PASSWORD, ip: "10.0.0.3" }, { userAgent: USER_AGENT }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "邮箱或密码不正确" });
  });

  test("AC-11-9 重置密码后旧会话全部失效，新密码可登录", async () => {
    const first = await login({ email: EMAIL, password: PASSWORD, ip: "10.0.0.4" }, { userAgent: USER_AGENT });
    const second = await login({ email: EMAIL, password: PASSWORD, ip: "10.0.0.5" }, { userAgent: USER_AGENT });

    await resetPassword(EMAIL, NEW_PASSWORD);

    const db = getDb();
    for (const grant of [first, second]) {
      const session = await db.session.findUnique({
        where: { tokenHash: hashSessionToken(grant.token) },
        select: { revokedAt: true },
      });
      expect(session?.revokedAt).toBeInstanceOf(Date);
    }

    await expect(
      login({ email: EMAIL, password: PASSWORD, ip: "10.0.0.6" }, { userAgent: USER_AGENT }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const fresh = await login(
      { email: EMAIL, password: NEW_PASSWORD, ip: "10.0.0.7" },
      { userAgent: USER_AGENT },
    );
    expect(fresh.user.email).toBe(EMAIL);
  });

  test("AC-11-10 库里没有明文密码，也没有会话令牌原文", async () => {
    const db = getDb();
    const user = await db.user.findUnique({ where: { email: EMAIL } });
    expect(user?.passwordHash).not.toContain(NEW_PASSWORD);
    expect(user?.passwordHash.startsWith("scrypt$")).toBe(true);

    const sessions = await db.session.findMany({ select: { tokenHash: true } });
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
