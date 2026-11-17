import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 容器部署产物：`next build` 后生成 .next/standalone，运行镜像只带运行所需文件。
  output: "standalone",
  // 生成代码与 pg 驱动在运行时按需加载，交给 Node 解析，避免被服务端打包器改写。
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  experimental: {
    // 会话校验在 src/proxy.ts 里对所有 /api 生效，它会先读完请求体；默认 10MB 上限会把
    // 「多张原图一起上传」在解析前截断，导致超限文件拿到「表单无法解析」而不是大小上限提示。
    // 单张上限仍由 MAX_UPLOAD_BYTES 在业务层逐张校验，这里只留出多张上传的总量余量。
    proxyClientMaxBodySize: "64mb",
  },
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
