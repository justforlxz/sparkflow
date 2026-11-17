# 验收记录

每行由 PL 在合并前的最后一个提交里追加（见 [../acceptance.md](../acceptance.md) 第 4 节）。
AC 覆盖一栏写实际跑过的用例文件与结果；人工验证写做了什么、结论是什么。

| 日期 | 功能 | PR / 合并提交 | AC 覆盖 | 人工验证 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 2026-11-17 | 01 骨架与契约（Next.js + Prisma + 功能开关机制） | PR #1 | AC-S1-1 ~ AC-S1-11 全过：单测 12 文件 / 55 用例（`pnpm test`）、集成 2 文件 / 7 用例（`tests/integration/accounts.test.ts`、`feature-flags.test.ts`）、e2e 14 用例（`tests/e2e/{accounts,errors,features,health,rate-limit}.spec.ts`）、CI run 44111140538 两个 job success | `docker compose up -d --build` 从零部署后 `GET /api/health` 200 且 `schemaVersion=2` 等于已应用迁移条数；`@devcontainers/cli@0.90.0 up` 返回 success，postCreate 完成装依赖与迁移；Desktop 1440 与 Mobile 375 截图各两张 | 通过，无阻断遗留 |
