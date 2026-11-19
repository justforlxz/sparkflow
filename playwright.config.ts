import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;

// 端到端验收一律走 mock 适配器。
// 起因：`.env.example` 里是 GENERATION_ADAPTER=real，本地照抄成 `.env` 后直接跑
// `pnpm test:e2e`，所有需要生成的用例都会因为「没有真实网关」整片失败，看起来像功能坏了。
// 这里给 webServer 的进程显式传值，覆盖 `.env` 的取值（Next 不会覆盖已存在的环境变量）；
// 只有自己显式导出 GENERATION_ADAPTER=real 时才走真实网关（只用于人工验证，不要进 CI）。
const generationAdapter = process.env.GENERATION_ADAPTER ?? "mock";

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
    env: {
      ...process.env,
      GENERATION_ADAPTER: generationAdapter,
    } as Record<string, string>,
  },
});
