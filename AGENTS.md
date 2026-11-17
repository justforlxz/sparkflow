# 仓库约定（给编码代理）

> 本仓库的代码由多个 agent 按 Issue 逐个交付。开始任何实现前，先读：
> `GLOSSARY.md`（用词）、`docs/architecture.md`（分层）、`docs/acceptance.md`（验收与合并）、
> 以及你要实现的那个 `docs/prd/*.md`。

## 技术栈（已定，不要更换）

- Next.js App Router + TypeScript，页面与接口同进程
- PostgreSQL + Prisma 7.10.1（`prisma` / `@prisma/client` / `@prisma/adapter-pg` 必须同版本，
  不要用 npm 的 `latest`，它当前指向 8.0.0 的 RC）
- 图片落本地磁盘（`UPLOAD_DIR`），通过鉴权路由读取
- 后台任务用进程内 worker
- Dockerfile + docker compose + devcontainer

## 目录

```
src/app/            # 路由与页面：只做参数解析、调用 service、组装响应
src/modules/<域>/   # 业务：schema(zod) / service / repo / 适配器 / 单测
src/lib/            # env、错误、响应信封、日志、加密、db
src/components/     # 通用 UI
prisma/schema/      # 按领域拆分的 schema 文件
prisma/migrations/  # 迁移，必须提交
tests/e2e/          # 端到端验收
```

依赖方向 `app → modules → lib`；`lib` 不得 import `modules`；模块之间只经 service 交互。

## 硬性规则

1. **模块化，不硬编码**。选项、枚举、提示词、视觉方向、平台列表、卡片文案都在模块常量文件或数据库里，
   不许写死在组件或路由中。新增一个选项只改一处。
2. **不改别人的模块**。需要别的模块的数据，调用它的 service；不要直接查它的表。
3. **schema 变更必须带迁移**。只改 schema 不提交迁移，视为未完成。
   迁移要向前兼容；删列/改名拆两个版本。
4. **密钥永不落地到客户端**。API Key 加密入库，接口只返回掩码；日志统一用 `src/lib/logger.ts`
   （已对 key/token/secret/authorization/cookie 脱敏）。
5. **功能可用性只经开关判定**。接口用 `requireEnabled(key)`，界面用 `<FeatureGate feature="...">`。
   业务代码里不允许出现 `if (key === "...")` 之类的具体判断。
6. **错误走统一信封**。路由用 `route()` 包装器，抛 `AppError`；不要在路由里手写错误 JSON。
7. **不阻塞请求**。任何模型调用都在 worker 里执行。
8. **不加不必要的依赖**。不引入状态管理库、GraphQL、tRPC、队列、对象存储。
9. **所有页面与接口都要登录**。新页面放 `src/app/(app)/` 路由组；接口用 `getCurrentUser()`，
   未登录页面 302、接口 401 JSON。白名单只有 `/login`、`/api/health`、`/api/auth/*`。
10. **数据访问集中在模块 `repo.ts`**。页面与路由里不写查询——将来引入工作区维度时要在这一层统一加过滤。

## 验收要求

- 每个功能都要有自动化验收：单测覆盖纯逻辑，e2e 覆盖用户可见行为，
  文件与用例标题按 `docs/acceptance.md` 的约定（标题带 AC 编号）。
- 涉及外部模型的用例用 `GENERATION_ADAPTER=mock` 的 mock 适配器，不消耗真实额度。
- 提交前跑 `pnpm check`（lint + typecheck + 单测）与相关 e2e；CI 必须全绿。

## 提交与 PR

- 一个 Issue 一个 PR，不要夹带无关改动。
- 提交信息用 `type(scope): 中文说明`（如 `feat(collections): 资源夹列表与编辑`）。
- PR 描述里列出：对应 AC 编号、验证命令与结果、已知限制。
- **PR 的最后一个提交由 PL 追加**（验收记录）。Coder 不要自己写这一条，也不要为了「让 PR 干净」而 rebase 掉它。

## 不要做

- 不要为了让测试变绿而改验收判据；判据有问题就报告。
- 不要为几乎不会发生的并发/安全边界引入额外机制（需要时先提出，由 PL 决定）。
- 不要引入演示数据、占位数字或 mock 兜底逻辑。
- 不要跳过迁移、不要手改数据库结构。
