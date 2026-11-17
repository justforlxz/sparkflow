# 05 图片创作（文生图，magpie 图片 MCP）

> 依赖：02 网关、03 Agent 配置、04 任务编排、10 功能开关 ｜ 对端：magpie 图片 MCP

## 目标

用图片创作 Agent 的配置，按文字要求生成一组新图片，落盘后成为创作结果的图片。

**本项目不实现图片生成模型**：出图调用 magpie 网关提供的图片 MCP。

## 本版本的范围边界

| 能力 | 本版本 | 说明 |
| --- | --- | --- |
| 文生图（按提示词出图） | 实现 | 本文件描述的主体 |
| 图生图（把原图作为参考） | **不实现** | 由功能开关 `image-to-image` 关闭；开关不可开启 |

凡与图生图相关的界面入口（例如资源夹详情里「按原图逐张重绘」的说明、参考图选择），
点击后提示「该功能未启用」，由统一的开关展示组件给出提示，不得各处自行判断。

## 调研结论（接口事实）

来源：magpie 仓库 `docs/reference.md` 与 `internal/gateway/image_mcp.go`。

- 端点：`POST <baseUrl>/mcp/magpie/image`，MCP Streamable HTTP（JSON-RPC）；
  跨机访问用 `Authorization: Bearer <网关 key>`。
- 工具：`generate_image`、`generation_result`（本版本用这两个；`generate_video` 不用）。
- `generate_image` 参数：`prompt`（必填）、`n`（**1–4**）、`size`（`1024x1536` 或 `3:4` 之类）、
  `quality`、`background`、`model`（可省略，省略时用 magpie 侧默认图片模型）、
  `reference_images`（本版本**不传**）。
- 返回：约 20 秒内就绪的直接返回图片（内联 ≤ 5 MiB，并给出一个网关 URL）；
  超过 20 秒返回 `id`，需用 `generation_result` 轮询取回。
- 网关 URL 上的图片**只保留 1 小时**，magpie 不替我们保存文件。

## 设计契约

### MUST

1. 适配器接口 `ImageGenerator`：`generate(input) => Promise<GeneratedImage[]>`，
   第一个实现 `MagpieMcpImageGenerator`；业务代码只依赖接口。
2. 按 `n = min(4, 剩余张数)` 分批调用：要 9 张就是 3 次（4+4+1）。
3. 拿到图片后**立刻下载并落盘**（`<UPLOAD_DIR>/generated-assets/<resultId>/<uuid>.<ext>`），
   再写 `generated_asset`。不得只保存网关 URL。
4. 上游返回 `id`（未就绪）时，用 `generation_result` 轮询（间隔 3 秒，上限为任务超时），
   不重复调用 `generate_image`。
5. `model` 取自任务快照；快照里没有模型时**省略该参数**（用 magpie 默认），不得自造模型名。
6. 提示词由「Agent 快照的 role / systemPrompt / outputRequirements」+「视觉方向」+「补充要求」拼装；
   拼装函数单独成函数并有单测。
7. 部分失败如实记录：成功几张落盘几张，失败写进阶段 `error`，阶段状态按 04 判定。
8. 记录调用信息（模型名、耗时、每次调用的张数），**不记录** `Authorization` 头与任何密钥。
9. 不得修改、移动、覆盖原始图片。

### SHOULD

- 视觉方向（清新生活感 / 杂志视觉 / 产品质感）的提示词描述集中放在
  `src/modules/image-generation/styles.ts`，页面只引用 key。
- 默认尺寸竖版 `1024x1536`，可由视觉方向覆盖。
- 失败分类：`UPSTREAM_TIMEOUT`、`UPSTREAM_AUTH`、`UPSTREAM_REJECTED`（参数/模型不支持）、`UPSTREAM_FORMAT`、
  `FEATURE_DISABLED`（图生图被调用时）。

### MAY

- 通过任务参数覆盖 `size` 与 `quality`。

### MUST NOT

- 不得在项目里实现图片生成模型、调度 GPU、内置任何出图后端。
- 不得在本版本传 `reference_images`（图生图未启用）。
- 不得在下载失败时把阶段标为成功。
- 不得缓存网关 URL 复用给后续任务（1 小时必然失效）。

## 数据与接口

上游：magpie 图片 MCP（见上）。
下游写入：`generated_asset`（id、result_id、storage_key、file_name、mime_type、sort_order、width、height）。

阶段元信息（`generation_stage.error` 之外的调用摘要，字段名自定）：
`{ model, batches: [{ n, ms, ok, errorCode? }], totalMs }`。

## 验收标准

| 编号 | 断言 | 自动化用例 |
| --- | --- | --- |
| AC-05-1 | 要 5 张时发 2 次 `generate_image`（4+1），断言调用次数与每次 `n` | 单测（mock 适配器） |
| AC-05-2 | 请求里不出现 `reference_images` 字段（本版本不传参考图） | 单测 |
| AC-05-3 | 快照没有模型时，请求体里没有 `model` 字段 | 单测 |
| AC-05-4 | 上游返回 `id` 时会轮询 `generation_result` 直到拿到图片，且不重复 generate | 单测 |
| AC-05-5 | 图片落盘后 `/api/files/...` 能读出正确字节与 `content-type` | 集成测试 |
| AC-05-6 | 3 张中 1 张失败：阶段 `failed` 或按 04 判定，结果的图片数与成功数一致 | 单测 |
| AC-05-7 | 调用 `image-to-image` 相关接口时返回 `FEATURE_DISABLED` | 单测 |
| AC-05-8 | 日志与阶段错误里不出现网关 key | 单测（日志断言） |

## 验证方式

```bash
pnpm test        # 分批、不传参考图、model 省略、轮询、部分失败、开关拦截
pnpm test:e2e    # mock 适配器跑通任务链路
```

真实连通（人工，一次性，结果写入验收记录）：配置 magpie 网关（`protocol = magpie-mcp`、
`baseUrl = https://magpie.mkacg.com`、填网关 key、模型条目填 magpie 侧可用的图片模型 ID），
对一个资源夹发起 4 张图的创作，确认图片落盘与展示。
