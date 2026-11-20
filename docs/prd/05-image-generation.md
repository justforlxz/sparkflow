# 05 图片创作（一图对一图，走 magpie 的图片编辑 MCP）

> 依赖：02 网关、03 Agent 配置、04 任务编排、10 功能开关 ｜ 对端：magpie 插件 `magpie-image-edit`

## 目标

把资源夹里的**每一张原始图片**变成一张对应的成品图：原图作为参考交给模型重绘，
一张原图出一张成品图，顺序与原图一致。

**本项目不实现图片生成模型，也不实现图生图逻辑**：全部经由 magpie 的 MCP 工具完成
（插件仓库 `github.com/justforlxz/magpie-image-edit`）。

## 上游接口事实（来自插件 README 与源码，2026-11-19）

插件在 magpie 的 MCP 里提供三个工具：

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `edit_image` | `prompt`（必填）、`images`（一张或几张；接受纯 base64 / `data:` URL / http 地址 / 本机路径） | `{status:"done", model, count, images:[{index, mimeType, bytes, b64}], totalBytes}` |
| `generate_image` | `prompt` | 同上（本版本不用：发起创作要求至少一张原图） |
| `image_result` | `jobId` | 同上；用于「还没画完」时轮询 |

- 插件自己最多等约 40 秒；超时先回 `{status:"running", jobId}`，调用方稍后用 `image_result` 取。
  **同一张图只画一次**，重复调用 `image_result` 不会重复计费。
- 图片以 **base64** 回包（约 1–2 MB/张），不是 URL —— 所以拿到就立刻落盘。

## 设计契约

### MUST

1. 适配器接口 `ImageGenerator.generate(input) => Promise<GeneratedImage[]>`；
   实现 `MagpieEditImageGenerator`，只依赖 MCP 工具名与返回结构，不依赖具体模型。
2. **一图对一图**：资源夹有 N 张原图，就发 N 次 `edit_image`，每次 `images` 只放那一张原图，
   期望 `count = 1`；成品按原图顺序写入 `sort_order`。
3. **单任务内完成全部原图**，不拆成多个任务、不分批；一张失败不影响其它张继续。
4. 原图传给上游前压缩：长边不超过 1536，转 JPEG（质量 85），**纯 base64**（不带 `data:` 前缀，
   插件两种都接受，纯 base64 少一层解析）。
5. 回包 `status:"running"` 时用 `image_result` 轮询（间隔 3 秒，上限为任务超时）；
   拿到 `images[].b64` 后立即解码落盘到 `generated-assets/<resultId>/`，写 `generated_asset`。
6. `mimeType` 以回包为准（不写死 png）；`bytes` 与实际落盘大小不一致时按落盘大小记录。
7. 失败如实记录到阶段 `error`：把失败的原图 id 与原因列出，阶段状态按 04 判定（部分成功即 `partial`）。
8. 不修改、不移动、不覆盖原始图片。
9. 记录每次调用的模型名与耗时；**不记录**网关 key、base64 图片内容。

### SHOULD

- 提示词 = Agent 快照的 role / systemPrompt / outputRequirements + 视觉方向描述 + 补充要求；
  拼装函数单独成函数并有单测。
- 视觉方向描述取自 `src/modules/image-generation/styles.ts` 的登记表。
- 一次任务里的 N 次调用串行执行（避免并发打满上游限流），每次之间不留固定 sleep。

### MAY

- 允许在资源夹里选「本次只重绘其中几张」（第一版不做，整夹全量）。

### MUST NOT

- 不得在项目内实现图片生成/编辑模型或调度 GPU。
- 不得把原图整体原样 base64（必须先压缩），也不得把 `b64` 回包写进日志。
- 不得因为某一张失败就丢弃已成功的其它张。
- 不得把「一图对一图」做成「固定 4 张」。

## 数据与接口

上游：magpie MCP（`edit_image` + `image_result`）。网关 `protocol` 仍为 `magpie-mcp`，
`baseUrl` 指向 magpie；具体工具端点与工具名由适配器内置常量给出（插件装上后 MCP 里会出现这三个工具）。

下游写入：`generated_asset`（id、result_id、storage_key、file_name、mime_type、sort_order、width、height、
source_asset_id）。**新增 `source_asset_id`**：记录这张成品对应哪张原图，供界面按原图对照展示。

## 验收标准

| 编号 | 断言 | 自动化用例 |
| --- | --- | --- |
| AC-05-1 | 资源夹 3 张原图 → 任务发出 3 次 `edit_image`，每次 `images` 长度为 1，且与原图一一对应 | 单测（mock 适配器，断言调用次数与每次入参） |
| AC-05-2 | 每个 `generated_asset.source_asset_id` 都能在原图集合里找到，且不重复 | 集成测试 |
| AC-05-3 | 传入上游的图片是压缩后的 JPEG、长边 ≤ 1536、纯 base64（无 `data:` 前缀） | 单测 |
| AC-05-4 | 回包 `status:"running"` 时轮询 `image_result` 直到拿到图片，不重复触发绘制 | 单测 |
| AC-05-5 | 3 张中第 2 张失败：结果保留 2 张成品、`sort_order` 为 1 和 3，任务为 `partial`，错误里点名第 2 张原图 | 单测 |
| AC-05-6 | 落盘文件字节与回包 `bytes` 一致，`mime_type` 与回包 `mimeType` 一致 | 集成测试 |
| AC-05-7 | 日志与阶段错误里不出现网关 key 与 base64 内容 | 单测（日志断言） |

## 验证方式

```bash
pnpm test
pnpm test:e2e    # mock 适配器跑通任务链路
```

真实连通（人工，一次性）：magpie 装好 `magpie-image-edit` 插件、设置里选好生图模型；
在 sparkflow 里对一个 3 张原图的资源夹发起创作，确认 3 张成品分别对应 3 张原图、可预览、可下载。
若插件尚未部署，本项记阻塞，不得用 mock 结论替代。
