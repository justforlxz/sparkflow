import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    // 集成测试连真实 PostgreSQL（DATABASE_URL），启动前自动应用迁移。
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    globalSetup: ["tests/integration/global-setup.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
