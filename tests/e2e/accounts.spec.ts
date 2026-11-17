import { expect, test } from "@playwright/test";
import { ACCOUNT } from "./support/auth";

// 首次注册是一次性的全局状态，因此本文件内按顺序执行；
// 跨文件顺序由 playwright.config.ts 的 projects 依赖固定（bootstrap → app → rate-limit），
// 这是「只有首个账号可自助注册」这条契约带来的取舍（docs/prd/11-accounts.md MUST 4）。
test.describe.configure({ mode: "serial" });

test("AC-11-1 空库首次访问被引导到 /login，注册后自动登录进入首页", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login(\?|$)/);
  await expect(page.getByRole("heading", { name: "拾光 · AI 内容工坊" })).toBeVisible();
  await expect(page.getByText("首次使用：创建第一个账号。")).toBeVisible();

  await page.getByLabel("姓名").fill(ACCOUNT.name);
  // 故意用大写邮箱注册：后面所有用例用小写登录，验证归一化只有一处。
  await page.getByLabel("邮箱").fill(ACCOUNT.email.toUpperCase());
  await page.getByLabel("密码").fill(ACCOUNT.password);
  await page.getByRole("button", { name: "创建账号并进入" }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "项目骨架已就绪" })).toBeVisible();
  await expect(page.getByText(ACCOUNT.name)).toBeVisible();
});

test("AC-11-2 已存在账号时注册接口返回 403，用户数不变", async ({ request }) => {
  const response = await request.post("/api/auth/register", {
    data: { email: "second@example.com", name: "第二人", password: "second-account-password" },
  });

  expect(response.status()).toBe(403);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("FORBIDDEN");
});

test("AC-11-3 错误密码与不存在的账号返回同一句文案", async ({ request }) => {
  for (const data of [
    { email: ACCOUNT.email, password: "wrong-password" },
    { email: "nobody@example.com", password: "wrong-password" },
  ]) {
    const response = await request.post("/api/auth/login", { data });
    expect(response.status()).toBe(401);

    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toBe("邮箱或密码不正确");
  }
});

test("AC-S1-7 登录页输错密码显示统一文案，不使用浏览器原生提示", async ({ page, request }) => {
  await request.post("/api/auth/logout");
  await page.goto("/login");

  await page.getByLabel("邮箱").fill(ACCOUNT.email);
  await page.getByLabel("密码").fill("wrong-password");
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page.getByRole("alert").filter({ hasText: "邮箱或密码不正确" })).toBeVisible();
  await expect(page).toHaveURL(/\/login\?error=login/);
});

test("AC-11-4 未登录访问页面 302 到 /login?next=...，接口返回 401 JSON", async ({ page, request }) => {
  await request.post("/api/auth/logout");

  await page.goto("/collections");
  expect(page.url()).toContain("/login?next=%2Fcollections");

  const apiResponse = await request.get("/api/collections");
  expect(apiResponse.status()).toBe(401);
  expect(apiResponse.headers()["content-type"]).toContain("application/json");
  const body = (await apiResponse.json()) as { error: { code: string } };
  expect(body.error.code).toBe("UNAUTHORIZED");
});

test("AC-11-5 登录后回到 next 指定的站内路径，跨站 next 被忽略", async ({ page, request }) => {
  await page.goto("/login?next=%2F%3Ffrom%3Dnext");
  await page.getByLabel("邮箱").fill(ACCOUNT.email);
  await page.getByLabel("密码").fill(ACCOUNT.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/?from=next");

  await request.post("/api/auth/logout");
  await page.goto("/login?next=https%3A%2F%2Fevil.example%2Fphish");
  await page.getByLabel("邮箱").fill(ACCOUNT.email);
  await page.getByLabel("密码").fill(ACCOUNT.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
});

test("AC-11-6 登出后访问受保护页面被重定向，旧 cookie 调接口返回 401", async ({ page, request }) => {
  await request.post("/api/auth/login", { data: ACCOUNT });
  const state = await request.storageState();
  const sessionCookie = state.cookies.find((cookie) => cookie.name === "sparkflow_session");
  expect(sessionCookie).toBeTruthy();

  await request.post("/api/auth/logout");
  await page.goto("/");
  expect(page.url()).toContain("/login");

  const stale = await request.get("/api/features", {
    headers: { cookie: `sparkflow_session=${sessionCookie?.value}` },
  });
  expect(stale.status()).toBe(401);
});
