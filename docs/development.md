# 开发、测试与部署

## 1. 本地环境（统一用 devcontainer）

本地开发只认一条路径：**在 devcontainer 里开发**，保证 Node、PostgreSQL、依赖版本一致。

```bash
# 支持 devcontainer 的编辑器：Reopen in Container
# 或命令行：
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bash
```

首次创建会自动执行 `.devcontainer/post-create.sh`：复制 `.env`、`pnpm install`、`prisma generate`、
`prisma migrate deploy`。

容器内 `pnpm dev` → http://localhost:3000。不要在宿主机直接 `pnpm dev`：
`.env` 里的 `DATABASE_URL` 指向 compose 内部的 `db` 服务。

## 2. 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm start` | 开发 / 构建 / 生产启动 |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `next typegen` + `tsc --noEmit` |
| `pnpm test` | Vitest 单元测试 |
| `pnpm test:integration` | Vitest 集成测试（连真实 PostgreSQL，先跑 `pnpm db:deploy`） |
| `pnpm test:e2e` | Playwright 端到端验收（自动应用迁移并起 dev server） |
| `pnpm check` | lint + typecheck + 单测，提交前跑 |
| `pnpm db:generate` | `prisma generate`（改完 schema 后） |
| `pnpm db:migrate` | `prisma migrate dev`（生成并应用迁移） |
| `pnpm db:deploy` | `prisma migrate deploy`（只应用已有迁移） |
| `pnpm db:studio` | `prisma studio` |
| `pnpm auth:reset-password <email>` | 交互式重置密码，并撤销该账号全部会话 |

依赖版本约束（ADR 0001）：`prisma` 与 `@prisma/client`、`@prisma/adapter-pg` 必须同版本，
且**钉稳定版 7.10.1** —— npm 的 `latest` 标签当前指向 8.0.0 的 RC，不要用 `latest`。

## 3. Prisma 使用约定

- schema 按领域拆在 `prisma/schema/*.prisma`；一个模块只改自己的文件。
- `prisma.config.ts` 指定 schema 目录与迁移目录；`DATABASE_URL` 只从环境变量读。
- 客户端通过驱动适配器连接（`@prisma/adapter-pg`），实例化集中在 `src/lib/db.ts`。
- 改 schema 的流程：改文件 → `pnpm db:migrate` 生成迁移 → **迁移 SQL 一起提交** → 本地验证。
- 迁移必须向前兼容：新版本能读旧数据；删列/改名拆两步发布。
- 生产升级 = 换镜像重启：容器启动执行 `prisma migrate deploy`，失败即不启动。

## 4. 部署

```bash
cp .env.example .env
# 至少改：POSTGRES_PASSWORD、AUTH_SECRET（openssl rand -base64 48）
docker compose up -d --build
```

- 应用 `http://<host>:${APP_PORT:-3000}`，健康检查 `GET /api/health`（数据库 + 结构版本）。
- 数据卷：`pgdata`、`uploads`。
- **首次启动**：浏览器打开首页会被引导到 `/login`，用「创建第一个账号」注册；之后注册入口自动关闭。
- **忘记密码**：`pnpm auth:reset-password <email>`（在容器内执行 `docker compose exec app pnpm auth:reset-password ...`），
  改完该账号的全部会话失效。
- **若将来启用图生图**（ADR 0004）：网关必须能访问本服务的地址，部署时要把对外地址配进环境变量。

## 5. 备份与恢复

```bash
docker compose exec db pg_dump -U sparkflow sparkflow > backup-$(date +%F).sql
docker run --rm -v sparkflow_uploads:/data -v "$PWD":/backup alpine \
  tar czf /backup/uploads-$(date +%F).tar.gz -C /data .
# 恢复：起 db → 导入 SQL → 解包图片卷 → 起 app（自动补齐迁移）
```

## 6. 排查

- `/api/health` 503：数据库不可达，看 `docker compose logs db`。
- 页面 500：`docker compose logs app`，日志是 JSON 行。
- 图片打不开：确认 `uploads` 卷挂载、`storage_key` 对应文件存在。
- 任务卡在处理中：重启后会被标记为 `failed`（`SERVER_RESTARTED`），点「重试」重跑失败阶段即可。
