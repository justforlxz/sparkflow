import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  // 首次注册只能发生一次，用例顺序由项目依赖固定：bootstrap → app → rate-limit。
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "line" : "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "bootstrap",
      testMatch: /accounts\.spec\.ts/,
    },
    {
      name: "app",
      testMatch: /.*\.spec\.ts/,
      testIgnore: [/accounts\.spec\.ts/, /rate-limit\.spec\.ts/],
      dependencies: ["bootstrap"],
    },
    {
      // 限速用例会锁住当前 IP，必须放在最后，避免影响其它用例的登录。
      name: "rate-limit",
      testMatch: /rate-limit\.spec\.ts/,
      dependencies: ["app"],
    },
  ],
  webServer: {
    command: `pnpm dev --port ${port}`,
    url: `${baseURL}/api/health`,
    // 限速器是进程内的：每次都起新进程，避免上一轮失败计数影响本轮。
    reuseExistingServer: false,
    timeout: 180_000,
    env: { ...process.env } as Record<string, string>,
  },
});
