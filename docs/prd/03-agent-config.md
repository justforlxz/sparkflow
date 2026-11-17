# 03 Agent 配置与设置页

> 依赖：02 网关 ｜ 被 04、05、06 依赖 ｜ 页面同时承载 10 功能开关

## 目标

维护两份固定的 Agent 配置（`image`、`copy`）：启用状态、名称、模型绑定、角色说明、系统提示词、
输出要求；并在创建任务时提供配置快照。

## 范围

包含：两份配置的读写、模型候选过滤、恢复默认、运行前就绪校验、配置快照生成；
设置页的页面结构（网关区块、Agent 区块、功能开关区块）。

不包含：自由创建 Agent、Agent 之间的编排。

## 设计契约

### MUST

1. 固定两个类型：`image`、`copy`，由迁移预置两条记录；用户不能新增或删除类型。
2. 模型候选按能力过滤：
   - `image` Agent → 只列 `capability = image`（能输出图片）的模型；
   - `copy` Agent → 只列 `capability = text` 或 `image_input` 的模型。
3. **`image` Agent 的模型绑定可以为空**：空表示「用网关侧的默认图片模型」，
   创建任务与执行时都必须接受空值，并在请求里省略模型参数。
4. `copy` Agent 必须绑定具体模型，不允许为空。
5. 保存时校验「网关存在 && 模型属于该网关 && 能力匹配」；不合法返回 `VALIDATION_FAILED`。
6. 快照接口返回：`agentType`、`enabled`、`name`、`gatewayId`、`protocol`、`baseUrl`、`modelId`（可为 null）、
   `role`、`systemPrompt`、`outputRequirements`。**快照不含 API Key**，密钥在执行时按 `gatewayId` 取。
7. 恢复默认只重置文案类字段，不动模型绑定；需要二次确认。
8. 任一 Agent 停用或未就绪（`copy` 缺模型、网关不可用）时，创建任务必须被拒绝，
   返回 `AGENT_NOT_READY` 并在 `details.agents` 里指出缺什么。

### 设置页结构

`/settings` 一个页面、三个区块（对应 V5 原型的「模型与 Agent 设置」）：

| 区块 | 内容 | 归属功能 |
| --- | --- | --- |
| 网关 | 网关列表、编辑弹窗、模型清单、测试连接 | 02 |
| Agent | 图片 Agent、文案 Agent 的配置表单 | 本文 |
| 功能开关 | 注册表里全部开关（可用 / 本版本未实现分组） | 10 |

MUST：三个区块共用同一套卡片与表单组件；区块之间不互相内联逻辑。

### SHOULD

- 默认值（名称、角色说明、提示词、输出要求）集中在 `src/modules/agent-config/defaults.ts`。
- 配置变更只影响之后创建的任务。
- 绑定失效（网关被删或被改）时，配置页显式提示「绑定已失效，请重新选择」，不静默回退。

### MAY

- 提供「测试这个 Agent」按钮：用当前配置发一次最小请求，验证绑定可用。

### MUST NOT

- 不得在配置变更时重写历史任务快照。
- 不得让 Agent 候选来自「所有网关的所有模型」而不做能力过滤。
- 不得把提示词写死在业务代码里。

## 数据与接口

`agent_config`：type（主键，image/copy）、enabled、name、gateway_id、gateway_model_id（可空）、
role、system_prompt、output_requirements、updated_at

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agents` | 两条配置 + 绑定信息 + 是否就绪 |
| PATCH | `/api/agents/[type]` | 更新配置 |
| POST | `/api/agents/[type]/reset` | 恢复默认文案字段 |
| GET | `/api/agents/models?type=image` | 该 Agent 可选模型（能力过滤后） |

## 验收标准

| 编号 | 断言 | 自动化用例 |
| --- | --- | --- |
| AC-03-1 | 两条配置互相独立：改文案 Agent 提示词不影响图片 Agent | `tests/e2e/agents.spec.ts` |
| AC-03-2 | 图片 Agent 候选里没有 `text` 能力的模型 | 同上 |
| AC-03-3 | 图片 Agent 的模型留空可以保存成功，且状态显示为「使用网关默认图片模型」 | 同上 |
| AC-03-4 | 文案 Agent 的模型留空保存被拒绝，错误指出原因 | 同上 |
| AC-03-5 | 选择不属于该网关的模型保存被拒绝 | 同上 |
| AC-03-6 | 恢复默认需确认，确认后提示词回默认值、模型绑定不变 | 同上 |
| AC-03-7 | 停用图片 Agent 后创建任务被拒绝（`AGENT_NOT_READY`） | 见 04 用例 |
| AC-03-8 | 任务创建后修改提示词，任务详情里的快照不变 | 同上 |
| AC-03-9 | 快照响应中没有任何密钥字段（用测试密钥全文搜索断言） | 单测 |

## 验证方式

```bash
pnpm test        # 候选过滤、空模型规则、快照生成、默认值
pnpm test:e2e    # tests/e2e/agents.spec.ts
```
