# 验收规范

> 每个功能点都必须有可自动执行的验收方案；全部功能完成后另有一次性全量验收。

## 1. 三层验收

| 层 | 工具 | 位置 | 管什么 |
| --- | --- | --- | --- |
| 单元 | Vitest | `src/**/*.test.ts` | 纯逻辑：派生状态、解析、拼装、加密脱敏、分批、开关生效规则 |
| 集成 | Vitest + 真实 PostgreSQL | `tests/integration/*.test.ts` | 落库与文件：迁移、级联删除、幂等 upsert、落盘 |
| 端到端 | Playwright | `tests/e2e/<功能>.spec.ts` | 用户看得见的行为：页面操作 + 接口结果 |

## 2. 每个功能一份 spec

| 功能 | 文档 | e2e 文件 |
| --- | --- | --- |
| 媒体资源夹 | [prd/01](prd/01-media-collection.md) | `collections.spec.ts` |
| 模型网关 | [prd/02](prd/02-model-gateway.md) | `gateways.spec.ts` |
| Agent 配置与设置页 | [prd/03](prd/03-agent-config.md) | `agents.spec.ts` |
| 创作任务与重试 | [prd/04](prd/04-generation-task.md) | `tasks.spec.ts` |
| 图片创作 | [prd/05](prd/05-image-generation.md) | 单测为主 |
| 文案创作 | [prd/06](prd/06-copy-generation.md) | 单测为主 |
| 任务与结果界面 | [prd/07](prd/07-results.md) | `results.spec.ts` |
| 发布 | [prd/08](prd/08-publish.md) | `publish.spec.ts` |
| 工作台 | [prd/09](prd/09-dashboard.md) | `dashboard.spec.ts` |
| 功能开关 | [prd/10](prd/10-feature-flags.md) | `features.spec.ts` |
| 全量 | 本文第 5 节 | `full-flow.spec.ts` |

写用例的要求：

1. 用例标题带上 AC 编号，例如 `test("AC-04-6 重试只重跑失败阶段")`。
2. 只断言用户可观测量：页面文字、可见状态、接口字段与状态码。
3. 每个用例自带数据准备与清理（资源夹名带随机后缀），不依赖执行顺序。
4. 涉及外部模型的用例一律用 mock 适配器（`GENERATION_ADAPTER=mock`），真实调用只做人工验证。

## 3. 外部依赖

- **magpie 图片 MCP / 文本网关**：CI 不真实调用。各适配器旁提供 `mock.ts`，按脚本返回固定图片与文案
  （图片用仓内小 PNG 字节），由 `GENERATION_ADAPTER=mock` 启用。
- **真实连通性**：人工验证项，写在对应功能的「验证方式」里，结论记入验收记录。

## 4. 合并协议（PL 执行）

1. Coder 提 PR，CI（lint / typecheck / 单测 / e2e）全绿。
2. Reviewer 评审通过（`in_review`），QA 功能检测通过（`in_validator`）。
3. 进入 `in_merge`：PL 检查可合并、无冲突、目标分支正确。
4. **PL 在 PR 分支追加最后一个提交**：只改 `docs/acceptance/records.md`，追加一行
   （功能、PR、AC 覆盖、人工验证结论、日期），提交信息 `chore(acceptance): 记录 <功能> 验收结果`。
5. 合并 PR。合并后 PR 的最后一个提交就是这条记录提交。
6. Issue 里贴合并提交 SHA，状态改 `done`。

验收记录不得并进功能提交，也不得由 Coder 代写 —— 它是「验收确实发生过」的证据。

## 5. 全量验收（所有功能完成后执行一次）

前置：01–10 全部 `done`，`main` 是最新代码。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
docker compose up -d --build        # 从零部署一次
```

`tests/e2e/full-flow.spec.ts` 覆盖的完整链路（mock 适配器）：

1. 设置页：新增网关（校验密钥掩码）、配置两个 Agent（图片 Agent 模型留空）、
   查看功能开关区块（两项均为「本版本未实现」且不可操作）。
2. 新建资源夹，上传 2 张图片，填写来源信息。
3. 编辑资源夹：新增 1 张、移除 1 张已有图片并撤销，再保存。
4. 发起创作（4 张图），等待两个阶段进入终态。
5. 查看任务：两个阶段状态独立可见；查看结果，编辑标题、正文、标签。
6. 制造文案阶段失败 → 点「重试」→ 只有文案阶段重跑，图片数不变。
7. 点「重新生成」→ 出现确认 → 确认后新增任务，旧结果仍在。
8. 整理发布：取消勾选 1 张、下载 ZIP、复制文案。
9. 点「分享到小红书」，断言提示「分享功能不可用」且无外部请求。
10. 点图生图相关入口，断言提示「该功能未启用」且无网络请求。
11. 标记已发布，检查全局与资源夹内记录一致（记录数仍为 1，重复标记不新增）。
12. 重启服务（`docker compose restart app`），确认数据仍在，且 `/api/health` 的结构版本
    与 `_prisma_migrations` 已应用条数一致。

人工部分（一次性，写入验收记录）：

- 真实 magpie 网关 + 真实图片模型：生成 4 张图，确认落盘与预览。
- 真实文本模型：生成一次文案，核对不照搬原文、无编造参数。
- 旧版本升级：用上一版镜像建的库，换新镜像启动后数据完整、迁移成功。

## 6. 验收记录

写在 [acceptance/records.md](acceptance/records.md)，一行一个功能；全量通过后再追加「v1.0 全量验收」。
