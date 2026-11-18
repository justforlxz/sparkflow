# 04 创作任务编排、阶段状态与重试

> 依赖：01 资源夹、02 网关、03 Agent 配置、10 功能开关 ｜ 被 05、06、07 依赖

## 目标

把「一次创作」建模成一条任务 + 两个可独立成败的执行阶段，异步执行、失败可诊断、
失败后**只重跑失败的那个阶段**。

## 范围

包含：任务创建、参数与配置快照、两阶段状态机、异步执行、失败/超时记录、阶段级重试、重新生成。

不包含：生成逻辑本身（05、06），任务与结果的界面（07）。

## 设计契约

### 阶段与状态

一个任务固定两个阶段：`image`（生图）、`copy`（文案）。

阶段状态：`queued`、`running`、`succeeded`、`failed`。
阶段字段：`attempts`（已排入执行队列的次数：创建即为 1，每次重试加 1）、`error`（`code`/`message`/`at`）、`started_at`、`finished_at`。

任务状态是**派生值**，不单独存储（或存储但与阶段状态必须一致）：

| 阶段组合 | 任务状态 | 结果 |
| --- | --- | --- |
| 两个都 succeeded | `succeeded` | 有，图片与文案完整 |
| image succeeded、copy failed | `partial` | 有，文案字段为空 |
| image failed、copy queued（未开始） | `failed` | 无 |
| 两个都 failed | `failed` | 无 |
| 任一 running | `running` | 可能已有图片 |

文案阶段只在生图阶段成功后开始；**生图失败时文案阶段保持 `queued`**，不执行也不报错。

### 产出写入时机

MUST：

1. 生图阶段成功后，创建 `generation_result` 并写入 `generated_asset`。
2. 文案阶段成功后，把标题/正文/标签写进该结果。
3. 生图失败 → 不创建结果，避免留下空壳。
4. 重试 copy 阶段时，复用已存在的结果行，不新建结果。

### 重试与重新生成（ADR 0005）

| 动作 | 接口 | 语义 |
| --- | --- | --- |
| 重试 | `POST /api/tasks/[id]/retry` | 只把**失败的那个阶段**置回 `queued`、`attempts + 1`，已成功阶段保持不动 |
| 重新生成 | `POST /api/collections/[id]/tasks` | 新建任务，两阶段都跑；旧任务与旧结果保留 |

MUST：

- 重试接口校验「确有失败阶段」，否则返回 `CONFLICT` 并说明当前状态。
- 重试不重置已成功阶段的 `attempts`。
- 重新生成在界面上必须先提示「将重新执行生图与文案两个阶段并产生新结果」，确认后调用。

### 异步执行

MUST：

1. 创建任务只写库并立即返回（响应给出任务 id），不阻塞请求。
2. 进程内 worker（ADR 0002）轮询 `queued` 阶段，一次执行一个任务。
3. 服务启动时：`running` 阶段 → `failed`（`code = SERVER_RESTARTED`），`queued` 阶段保留待跑。
4. 每个任务保存 `agent_snapshot`（见 03），运行时只读快照 + 按 `gateway_id` 取密钥。
5. 失败写入可诊断信息：`code`、`message`（已脱敏）、发生时间。
6. 同一资源夹可连续创建多个任务，任务间数据互不共享。

SHOULD：

- 单任务总超时默认 15 分钟，超时把当前阶段置 `failed`（`code = TIMEOUT`）。
- worker 轮询间隔 1–2 秒。

MUST NOT：

- 不得在 HTTP 请求内同步执行生成。
- 不得把失败阶段伪装成成功，也不得自动无限重试。
- 不得在生图失败时仍创建空的创作结果。

## 数据与接口

`generation_task`：id、collection_id、visual_style、copy_style、image_count、extra_prompt、
agent_snapshot（jsonb）、created_at

`generation_task` 没有 `result_id` 列。「一个任务最多一个结果」由 `generation_result.task_id` 的
唯一约束表达；任务详情响应里的 `resultId` 是从这条约束反查出来的派生输出，不落库。

`generation_stage`：id、task_id、stage、status、attempts、error（jsonb）、started_at、finished_at

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/collections/[id]/tasks` | 创建任务（= 重新生成的能力） |
| GET | `/api/tasks` | 列表（含派生状态、阶段摘要） |
| GET | `/api/tasks/[id]` | 详情（两阶段状态、快照、错误、结果 id） |
| POST | `/api/tasks/[id]/retry` | 只重试失败阶段 |

## 验收标准

| 编号 | 断言 | 自动化用例 |
| --- | --- | --- |
| AC-04-1 | 创建任务立即返回（< 1s），两阶段初始状态为 `queued` | `tests/e2e/tasks.spec.ts` |
| AC-04-2 | 两个阶段都成功后，任务派生状态为 `succeeded` 且关联到结果 | 同上 |
| AC-04-3 | 同一资源夹连续创建两次任务，产生两条任务与两个结果 | 同上 |
| AC-04-4 | 停用图片 Agent 后创建任务被拒绝（`AGENT_NOT_READY`），不产生任务记录 | 同上 |
| AC-04-5 | 让文案阶段失败：任务为 `partial`，结果存在且图片完整、文案为空 | 单测（mock 适配器） |
| AC-04-6 | 对 `partial` 任务点「重试」：只有文案阶段重跑，`attempts` 变为 2，生图阶段 `attempts` 仍为 1，图片未被替换 | 单测 + e2e |
| AC-04-7 | 对 `failed`（生图失败）任务点「重试」：只重跑生图，成功后创建结果 | 单测 |
| AC-04-8 | 对全部成功的任务调用重试：返回 `CONFLICT`，不产生副作用 | 单测 |
| AC-04-9 | 「重新生成」会新建任务且旧结果仍在 | e2e |
| AC-04-10 | 服务重启后，重启前的 `running` 阶段变为 `failed`（`SERVER_RESTARTED`），`queued` 阶段仍会被执行 | 单测 |

## 验证方式

```bash
pnpm test        # 派生状态表、重试语义、产出写入时机、重启恢复
pnpm test:e2e    # tests/e2e/tasks.spec.ts（mock 适配器）
```
