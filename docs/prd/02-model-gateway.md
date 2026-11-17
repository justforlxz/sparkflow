# 02 模型网关与凭据安全

> 依赖：无（属于架构基线）｜ 被 03 依赖

## 目标

让用户用自己的模型服务：配置网关（接口形状、Base URL、API Key）、维护可调用的模型清单，
并由两个 Agent 从这里选择模型。

## 范围

包含：网关 CRUD、模型清单 CRUD、连接测试、凭据加密与掩码、被引用时禁止删除。

不包含：自动发现模型清单（第一版手填）、按 token 计费统计。

## 设计契约

### 接口形状（protocol）与模型能力（capability）是两件事

产品需求原文把协议写成「OpenAI 兼容 / Anthropic 兼容」，那描述的是**请求格式**；
而出图能力属于**模型能力**（Anthropic Messages 根本无法生成图片）。因此拆成两列。

`gateway.protocol`：

| protocol | 用途 | 端点约定 |
| --- | --- | --- |
| `openai-chat` | 文本 | `POST <baseUrl>/chat/completions` |
| `anthropic-messages` | 文本 | `POST <baseUrl>/messages` |
| `magpie-mcp` | 图片 | `POST <baseUrl>/mcp/magpie/image`（JSON-RPC `tools/call`） |

新增一种形状 = 新增一个适配器并登记，不改业务代码。

`gateway_model.capability`：

| 标签 | 含义 | 谁能选 |
| --- | --- | --- |
| `text` | 能生成文本 | 文案 Agent |
| `image` | **能输出图片** | 图片 Agent |
| `image_input` | 能吃图片输入（仅作提示，本版本不影响出图） | 文案 Agent 可选 |

「多模态」不作为标签使用：能读图不等于能出图，把只读图的模型选给图片 Agent 必然失败。

### MUST

1. API Key 服务端加密保存（用 `AUTH_SECRET` 派生的独立子密钥），响应只返回掩码与
   `hasApiKey: true`，**不返回明文**。
2. 编辑时未重新输入密钥则保留原密钥，不得因字段为空而清空。
3. 删除被 Agent 引用的网关返回 `CONFLICT` 并指出引用方，不静默解绑。
4. 删除网关级联删除其模型条目。
5. 同一网关内 `model_id` 唯一。
6. 连接测试必须发真实请求，并区分「网络错误 / 鉴权失败 / 配置错误」三类。
7. 日志、错误响应、堆栈中不得出现密钥或 `Authorization` 原文（统一走脱敏日志）。

### SHOULD

- `magpie-mcp` 的连接测试：调用 MCP 的 `initialize` + `tools/list`，确认端点存在且 key 可用。
- 文本协议的连接测试：一次最小 chat 调用（`max_tokens: 1`）验证鉴权。
- Base URL 去掉尾部 `/` 后再拼接；列表展示模型数量与最近一次测试结果。

### MAY

- 允许 Base URL 指向内网地址，不做可达性预校验。

### MUST NOT

- 不得把密钥写进前端状态、Cookie、localStorage。
- 不得在库里保存明文密钥，不得把密钥写进日志。
- 不得在删除网关时自动把 Agent 指向别的网关。

## 数据与接口

`gateway`：id、name、protocol、base_url、encrypted_api_key、created_at、updated_at
`gateway_model`：id、gateway_id、model_id、capability、created_at

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/gateways` | 列表（掩码、模型清单、引用情况） |
| POST | `/api/gateways` | 新增 |
| PATCH | `/api/gateways/[id]` | 编辑（密钥留空=保留） |
| DELETE | `/api/gateways/[id]` | 删除；被引用 409 |
| POST | `/api/gateways/[id]/test` | 连接测试 |
| POST/DELETE | `/api/gateways/[id]/models[/$modelId]` | 模型条目增删 |
| GET | `/api/gateways/models?capability=image` | Agent 候选列表 |

## 验收标准

| 编号 | 断言 | 自动化用例 |
| --- | --- | --- |
| AC-02-1 | 新增网关后可持久化，刷新仍在，密钥显示为掩码 | `tests/e2e/gateways.spec.ts` |
| AC-02-2 | 接口响应与页面源码中不出现完整密钥（用测试密钥全文搜索） | 同上 |
| AC-02-3 | 未重输密钥的编辑保存后，原密钥仍可用（连接测试成功） | 同上 |
| AC-02-4 | 删除被引用的网关返回 409，并指出引用方 | 同上 |
| AC-02-5 | `text` 能力的模型不出现在图片 Agent 候选里 | 同上 |
| AC-02-6 | 连接测试能区分鉴权失败与网络错误（用本地 mock 端点） | 同上 |

## 验证方式

```bash
pnpm test        # 加密/掩码、适配器参数拼装、错误分类
pnpm test:e2e    # tests/e2e/gateways.spec.ts
```

人工项：对真实 magpie 网关执行一次连接测试，确认结果与页面一致。
