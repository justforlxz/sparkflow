import { expect, test } from "@playwright/test";
import { ensureAccount } from "./support/auth";

test("AC-S1-3 未登录访问未定义接口返回 401 JSON 信封", async ({ request }) => {
  await request.post("/api/auth/logout");

  const response = await request.get("/api/nonexistent");
  expect(response.status()).toBe(401);
  expect(response.headers()["content-type"]).toContain("application/json");

  const body = (await response.json()) as { ok: boolean; error: { code: string } };
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe("UNAUTHORIZED");
});

test("AC-S1-3 登录后访问未定义接口返回 NOT_FOUND JSON（非 HTML）", async ({ request }) => {
  await ensureAccount(request);

  const response = await request.get("/api/nonexistent");
  expect(response.status()).toBe(404);
  expect(response.headers()["content-type"]).toContain("application/json");

  const body = (await response.json()) as { ok: boolean; error: { code: string; message: string } };
  expect(body).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});
