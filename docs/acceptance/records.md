# 验收记录

每行由 PL 在合并前的最后一个提交里追加（见 [../acceptance.md](../acceptance.md) 第 4 节）。
AC 覆盖一栏写实际跑过的用例文件与结果；人工验证写做了什么、结论是什么。

| 日期 | 功能 | PR / 合并提交 | AC 覆盖 | 人工验证 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 2026-11-17 | 01 骨架与契约（Next.js + Prisma + 功能开关机制） | PR #1 | AC-S1-1 ~ AC-S1-11 全过：单测 12 文件 / 55 用例（`pnpm test`）、集成 2 文件 / 7 用例（`tests/integration/accounts.test.ts`、`feature-flags.test.ts`）、e2e 14 用例（`tests/e2e/{accounts,errors,features,health,rate-limit}.spec.ts`）、CI run 44111140538 两个 job success | `docker compose up -d --build` 从零部署后 `GET /api/health` 200 且 `schemaVersion=2` 等于已应用迁移条数；`@devcontainers/cli@0.90.0 up` 返回 success，postCreate 完成装依赖与迁移；Desktop 1440 与 Mobile 375 截图各两张 | 通过，无阻断遗留 |
| 2026-11-17 | 03 模型网关与设置页骨架（含设置页网关区块） | PR #3 | AC-02-1 ~ AC-02-6、AC-03-7、AC-03-8 全过：单测 18 文件 / 105 用例（`pnpm test`）、e2e 20 通过 / 1 跳过 / 0 失败（`tests/e2e/gateways.spec.ts`；AC-02-4 的端到端用例按范围标为 `test.fixme`，引用查询由 N4 补齐后启用）、CI run 44201258425 两个 job success | 12 种上游行为逐一实测连接测试分类（`401/403→auth`、`500`/端口不通/8 秒超时`→network`、`400`/magpie 返回 HTML/JSON-RPC 报错/缺 `text` 模型`→config`）；接口响应与页面源码全文搜索测试密钥命中 0 次；移除 `AUTH_SECRET` 后启动退出码 1 并指向该变量；数据库不可达返回 503 统一信封；Desktop 1440、Desktop 1280、Mobile 375 及新增/编辑弹窗截图各一张 | 通过，无阻断遗留 |
| 2026-11-18 | 02 媒体资源夹与原始文件（资源夹 CRUD、原图上传与鉴权读取、级联清理、`/collections` 页面） | PR #2 | AC-01-1 ~ AC-01-7、AC-02-8、AC-02-9 全过：单测 18 文件 / 101 用例（`pnpm test`）、集成 3 文件 / 13 用例（`tests/integration/media-collection.test.ts` 等，真实 PostgreSQL）、e2e 23 用例（含 `tests/e2e/collections.spec.ts` 9 条，用例标题带 AC 编号）、CI run 44198959165 两个 job success；AC-02-10 判定点就位（`CONFLICT` + `COLLECTION_BUSY` 有单测），端到端要等 N5 接入任务表后生效 | 独立 PostgreSQL 17 容器空库从零应用 3 条迁移、`pnpm build` standalone 产物起服务实测上传 / `/api/files` 读取 / `?w=` 缩放 / 删除清理；Desktop 1280×900 与 Mobile 375×812 截图（空状态、新建、列表、详情、编辑三态、删除确认）；另发现编辑整组换图保存失败会留下部分改动，AC 未覆盖，已另开 MKACG-870 跟踪 | 通过，无阻断遗留 |
