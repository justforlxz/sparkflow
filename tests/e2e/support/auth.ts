import { expect, type APIRequestContext } from "@playwright/test";

/** e2e 共用的测试账号。首个注册用例用它建号，其余用例用它登录。 */
export const ACCOUNT = {
  email: "owner@example.com",
  name: "站长",
  password: "e2e-account-password",
};

export async function loginAs(
  request: APIRequestContext,
  password: string = ACCOUNT.password,
): Promise<void> {
  const response = await request.post("/api/auth/login", {
    data: { email: ACCOUNT.email, password },
  });
  expect(response.status()).toBe(200);
}

/** 没有账号就注册（空库场景），已有账号就登录。 */
export async function ensureAccount(request: APIRequestContext): Promise<void> {
  const me = await request.get("/api/auth/me");
  expect(me.status()).toBe(200);
  const body = (await me.json()) as { data: { hasAnyUser: boolean } };

  if (!body.data.hasAnyUser) {
    const register = await request.post("/api/auth/register", { data: ACCOUNT });
    expect(register.status()).toBe(201);
    return;
  }

  await loginAs(request);
}
