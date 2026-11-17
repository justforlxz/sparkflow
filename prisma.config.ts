import { defineConfig } from "prisma/config";

// Prisma CLI 的配置只服务生成与迁移；应用运行时从 `src/lib/env.ts` 读环境变量。
// 这里的默认值仅用于「本机没有 .env 时也能生成客户端」，不代表可用的数据库地址。
export default defineConfig({
  schema: "prisma/schema",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/sparkflow",
  },
});
