import { expect, test } from "@playwright/test";
import { ACCOUNT, loginAs } from "./support/auth";

test("AC-11-8 同一 IP 连续 5 次密码错误后返回 429", async ({ request }) => {
  // 先成功登录一次，清掉前面用例可能留下的失败计数。
  await loginAs(request);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await request.post("/api/auth/login", {
      data: { email: ACCOUNT.email, password: `wrong-password-${attempt}` },
    });
    expect(response.status()).toBe(401);
  }

  const blocked = await request.post("/api/auth/login", {
    data: { email: ACCOUNT.email, password: ACCOUNT.password },
  });
  expect(blocked.status()).toBe(429);

  const body = (await blocked.json()) as {
    error: { code: string; details?: { code: string; retryAfterSeconds: number } };
  };
  expect(body.error.details?.code).toBe("TOO_MANY_ATTEMPTS");
  expect(body.error.details?.retryAfterSeconds).toBeGreaterThan(0);
});
