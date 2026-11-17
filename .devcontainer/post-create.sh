#!/usr/bin/env bash
# devcontainer 首次创建时执行：生成 .env、装依赖、生成客户端、应用迁移。
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  secret="$(openssl rand -base64 48 | tr -d '\n')"
  # 用 sed 替换占位空值，避免把密钥写进仓库文件。
  sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=${secret}|" .env
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=devpassword|" .env
fi

# .env.example 的 DATABASE_URL 指向宿主机；容器内的数据库是 compose 的 db 服务。
if grep -q '^DATABASE_URL=.*localhost:5432' .env; then
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://sparkflow:devpassword@db:5432/sparkflow|" .env
fi

# 本脚本以镜像的 node 用户执行（写 /usr/local/bin 需要 sudo）。
# 用 package.json 的 packageManager 钉住 pnpm 版本，避免与镜像自带版本不一致。
pnpm_version="$(node -p 'require("./package.json").packageManager.split("@").pop()')"
sudo npm install --global --no-fund --no-audit "pnpm@${pnpm_version}"

pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:deploy

echo "准备完成：pnpm dev 后访问 http://localhost:3000"
