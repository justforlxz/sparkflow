# 架构与工程约定

> 解释「代码怎么组织、为什么这样分层」。改动跨模块结构先改这里；决策背景见 `docs/adr/`。

## 1. 全景

单个 Next.js 应用（App Router）同时承担页面与接口，PostgreSQL 存业务数据，本地磁盘存图片。
没有独立后端服务、没有消息队列、没有对象存储 —— 单用户自托管场景下这些都是额外运维成本。

```mermaid
flowchart LR
  B[浏览器] -->|页面 / fetch| N["Next.js app<br/>（App Router）"]
  N -->|Prisma| P[(PostgreSQL)]
  N -->|读写| D["本地磁盘<br/>UPLOAD_DIR"]
  N -->|MCP over HTTP| M[magpie 图片 MCP]
  N -->|chat / messages| G[文本模型网关]
```

## 2. 分层

```
src/app/            # 路由层：页面与 /api 路由，只做参数解析 + 调用 service + 组装响应
src/modules/<域>/   # 业务层：schema(zod) / service / repo / prompt / 适配器 / 单测
src/lib/            # 横切能力：env、错误、响应信封、路由包装器、日志、加密
src/components/     # 通用 UI：Panel、EmptyState、Toast、ConfirmDialog、FeatureGate…
prisma/             # schema 与迁移
tests/e2e/          # 端到端验收
```

依赖方向单向：`app → modules → lib`，`modules → prisma`。
`lib` 不允许 import `modules`；模块之间只能通过对方导出的 service 函数交互，不能直接读别的模块的表。

## 3. 数据层

- ORM 统一用 Prisma（ADR 0001）。schema 放在 `prisma/schema/` 下**按领域拆分多个 `.prisma` 文件**
  （Prisma 的多文件 schema），一个功能模块只改自己那个文件，减少并行开发时的冲突。
- 迁移由 `prisma migrate` 生成，**迁移目录随代码提交**。
- 生产升级：容器启动时执行 `prisma migrate deploy`，失败则容器不启动，不带旧结构接流量。
- 结构版本由 `_prisma_migrations` 的已应用条数派生，健康检查返回它。
- 破坏性变更（删列、改名）拆成两个版本：先加新列并双写，后续版本再删旧列。

## 4. 关键横切点

### 响应信封

`/api` 成功 `{ ok: true, data }`；失败 `{ ok: false, error: { code, message, details? } }`。
`route()` 包装器把 `AppError` / `ZodError` / 未知异常翻译成状态码，**路由里不手写错误 JSON**。

错误码：`VALIDATION_FAILED`、`NOT_FOUND`、`CONFLICT`、`UNAUTHORIZED`、`FORBIDDEN`、
`UPSTREAM_FAILED`、`INTERNAL`；业务子码放 `details`（如 `AGENT_NOT_READY`、`FEATURE_DISABLED`、
`FEATURE_NOT_IMPLEMENTED`、`SERVER_RESTARTED`、`TIMEOUT`）。

### 功能开关（ADR 0003）

三层：代码里的注册表 → `feature_flag` 表 → 唯一判定入口。
实际可用 = `registry.implemented && (row.enabled ?? registry.defaultEnabled)`。
接口入口调用 `requireEnabled(key)`；界面入口用 `<FeatureGate feature="...">`。
业务代码里不允许出现按 key 判断的 if。

### 配置与密钥

- 只有「这台机器怎么跑」进环境变量（`src/lib/env.ts` 唯一入口）。
- 业务配置（网关、模型、提示词、视觉方向、平台选项）在数据库或模块常量文件里，不散落在组件里。
- 网关 API Key 加密入库，密钥由 `AUTH_SECRET` 派生（HKDF），不复用会话签名密钥。
- 日志统一走 `src/lib/logger.ts`，对 `key|token|secret|password|authorization|cookie` 字段与
  `sk-…`、`Bearer …` 形态脱敏。

### 文件

`UPLOAD_DIR` 下两类：`media-assets/<collectionId>/`（原图）、`generated-assets/<resultId>/`（生成图）。
文件名服务端生成，数据库只存 `storage_key`。读取统一经 `/api/files/[...key]`，校验会话后返回字节；
缩略图用 `?w=` 当场处理，不预生成文件。

### 任务执行（ADR 0002、0005）

- `generation_task` 一条 + `generation_stage` 两条（image / copy）。任务状态由阶段状态派生。
- 进程内 worker 轮询 `queued` 阶段，一次执行一个任务；启动时把 `running` 阶段记为失败。
- 重试只重置失败阶段；重新生成 = 新建任务。
- 扩展点：将来要多实例，把取任务换成 `FOR UPDATE SKIP LOCKED`，阶段逻辑不变。

## 5. 扩展点

| 要加的东西 | 改动位置 |
| --- | --- |
| 新的接口形状（协议） | `src/modules/gateway/adapters/` 加文件 + 注册 + 枚举加值 |
| 新的功能开关 | `feature-flags/registry.ts` 加一项（必要时加一条迁移） |
| 新的视觉方向 / 文案风格 | 对应模块的 `styles.ts` |
| 新的执行阶段 | `generation_stage.stage` 枚举 + 派生状态表 + worker 分支 |
| 新的页面 | `src/app/<路由>/page.tsx`，只组合模块与通用组件 |

## 6. 明确不做

- 不引入 GraphQL / tRPC / 状态管理库。
- 不在 Prisma 上再包一层通用 repository 基类。
- 不做多语言、不做微服务、不做 Redis、不做对象存储、不做多实例。
