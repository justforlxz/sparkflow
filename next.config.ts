import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 容器部署产物：`next build` 后生成 .next/standalone，运行镜像只带运行所需文件。
  output: "standalone",
  // 生成代码与 pg 驱动在运行时按需加载，交给 Node 解析，避免被服务端打包器改写。
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  // e2e 与容器内都用 127.0.0.1 访问 dev server。
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
