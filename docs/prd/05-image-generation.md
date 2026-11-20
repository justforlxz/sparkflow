# 05 图片提取（从场景里取出目标，一图对一图，走 magpie 图片 MCP）

> 依赖：02 网关、03 Agent 配置、04 任务编排、10 功能开关 ｜ 对端：magpie 插件 `magpie-image-edit`

## 目标

把资源夹里的**每一张原始图片**里指定的目标取出来，做成一张可以直接使用的素材图：
一条原图出一张提取图，顺序与原图一致。

「提取」不是「重绘」：重绘乐于改变与美化，提取要求**不改结构、只搬运**——
忠实保留目标自身的纹理、材质、图案与颜色，把与目标无关的场景元素全部去掉。

**本项目不实现图片生成模型，也不实现图生图逻辑**：全部经由 magpie 的 MCP 工具完成
（插件仓库 `github.com/justforlxz/magpie-image-edit`）。

## 上游接口事实（2026-11-20 对线上 endpoint 实测 `tools/list`）

线上 `https://magpie.mkacg.com/mcp/magpie/image`（serverInfo `magpie-image` v0.1.4582）暴露的工具是
**magpie 内置的三件**，不是 `magpie-image-edit` 插件的 `edit_image` / `image_result`：

| 工具 | 必填 | 可用参数 |
| --- | --- | --- |
| `generate_image` | `prompt` | `n`、`size`、`resolution`、`quality`、`background`、`complexity`、`model`、`reference_images` |
| `generate_video` | `prompt` | 本版本不用 |
| `generation_result` | `id` | 轮询未就绪的生成结果 |

因此**图生图走 `generate_image` 的 `reference_images` 参数**，不是 `edit_image`；
轮询工具名是 `generation_result`，不是 `image_result`。

要点：

- `n` 上限 4；一图对一图时每次 `n = 1`、`reference_images` 只放那一张原图。
- 生成可能同步完成，也可能返回一个 id，需要 `generation_result` 轮询；同一 id 轮询不重复计费。
- 图片可由回包内联或由网关 URL 提供；URL 只保留约 1 小时，因此拿到就落盘。

### 水印（实测结论，2026-11-20）

sensenova 默认模型（`sensenova-token-plan/sensenova-u1.5-lite`）出图右下角带「日日新 / senseNova」水印。
通过 magpie 的两条路径都试过传 `watermark: false`：

| 路径 | 结果 |
| --- | --- |
| MCP `generate_image`（在本体参数里加 `watermark: false`） | 不报错（200，工具 schema 未拒绝未知字段），取回成品**水印仍在** |
| REST `POST /v1/images/generations`（加 `watermark: false`） | 200 返回 b64，成品**水印仍在** |

因此：

- **MUST NOT** 在实现里加 `watermark` 参数或以为它能关水印；magpie 与 sensenova 这条链路上无效。
- 也不要把「不要水印」写成提示词要求然后承诺无水印——实测同模型下提示词无效。
- 界面必须展示定稿文案（下一节），两处共用同一个常量，不得各写一版。

### 水印提示文案（定稿，2026-11-20）

**主文案**（结果卡片展开区、发布准备弹窗，两处逐字一致）：

> 图片由你在设置里选择的图片模型生成，可能自带该模型的水印或角标。发布前请确认能否接受；不接受时，可在设置里换一个不加水印的模型重新生成。

**短文案**（折叠态那一行，或窄屏放不下主文案时）：

> 该模型可能自带水印，发布前请确认。

要求：

- 两句都放在 `PUBLISH_COPY` 一类的共享常量里，两个展示点引用同一个键，不允许各写一份。
- 提示是**说明**，不是**阻断**：不加勾选确认、不弹二次窗口、不阻止标记发布。
- 必须同时满足：说清「图片是哪个模型生成的」「水印可能来自模型」「不接受时该怎么办」。
- 禁止出现的措辞：「已去除水印」「保证无水印」「上游模型」「系统已校验」「图片合格」，
  也不要写「忽略此提示即可继续」这类诱导。
- 折叠态只显示短文案；展开后显示主文案（`docs/prd/07` 的折叠规则）。

## 设计契约

### 提取目标与提取要求

- **提取目标**来自资源夹的 `extract_target`（ADR 0009），例如「桌垫的织物纹理」。创建任务时写进快照。
- **提取要求**替代原来的「视觉方向」，三选一：

| key | 中文 | 交给模型的描述 |
| --- | --- | --- |
| `faithful` | 忠实还原 | 不改颜色与结构，只把目标拉平、去透视，保留原本的纹理走向与细微瑕疵 |
| `flatten` | 平整化 | 压平褶皱、折痕与光照不均，让纹理均匀铺满画面，可直接当材质使用 |
| `dereflect` | 去反光 | 去掉高光、反光与边缘阴影，还原目标真实的颜色与明暗 |

### 输出形态

固定为**去透视的平铺素材图**：

- 画面里只有目标本身，没有桌面、道具、背景或场景阴影；
- 目标拉平成正面视角、四边完整、铺满画面；
- 不添加原图里没有的文字、水印或标识。

### MUST

1. 适配器接口 `ImageGenerator.generate(input) => Promise<GeneratedImage[]>`；
   实现 `MagpieImageGenerator`，只依赖 MCP 工具名与返回结构，不依赖具体模型。
2. **一图对一图**：资源夹有 N 张原图，就发 N 次 `generate_image`，每次 `n = 1` 且
   `reference_images` 只放那一张原图；成品按原图顺序写入 `sort_order`。
3. **单任务内完成全部原图**，不拆成多个任务、不分批；一张失败不影响其它张继续。
4. 原图传给上游前压缩：长边不超过 1536，转 JPEG（质量 85），以 **data URL**
   （`data:image/jpeg;base64,...`）放进 `reference_images`；实测内联 b64 与 data URL 两种写法都可以，
   本实现统一用 data URL。
5. 超过约 20 秒没画完时，工具结果只回作业 id（`_meta["usemagpie.ai/pending"]`），
   此时只能用 `generation_result` 轮询（间隔 3 秒，上限为任务超时）；拿到成品
   （`content` 里的 image 块内联 b64，或 `_meta["usemagpie.ai/files"]` 与文字里的 URL）后
   立即取回字节、写盘到 `generated-assets/<resultId>/`，写 `generated_asset`。
6. `mimeType` 以回包为准（不写死 png；内联取 image 块的 `mimeType`，URL 取下载响应的
   `content-type`）；`bytes` 与实际落盘大小不一致时按落盘大小记录。
7. 失败如实记录到阶段 `error`：把失败的原图 id 与原因列出，阶段状态按 04 判定（部分成功即 `partial`）。
8. 不修改、不移动、不覆盖原始图片。
9. 记录每次调用的模型名与耗时；**不记录**网关 key、base64 图片内容。

### SHOULD

- 提示词 = Agent 快照的 role / systemPrompt / outputRequirements + **提取目标** + 提取要求描述 + 补充要求；
  拼装函数单独成函数并有单测。
- 提取要求的描述取自 `src/modules/image-generation/styles.ts` 的登记表（键名从「视觉方向」改成「提取要求」）。
- 一次任务里的 N 次调用串行执行（避免并发打满上游限流），每次之间不留固定 sleep。

### MAY

- 允许在资源夹里选「本次只重绘其中几张」（第一版不做，整夹全量）。

### MUST NOT

- 不得在项目内实现图片生成/编辑模型或调度 GPU。
- 不得把原图整体原样 base64（必须先压缩），也不得把 `b64` 回包写进日志。
- 不得因为某一张失败就丢弃已成功的其它张。
- 不得把「一图对一图」做成「固定 4 张」。

## 数据与接口

上游：magpie MCP（`generate_image` + `generation_result`）。网关 `protocol` 仍为 `magpie-mcp`，
`baseUrl` 指向 magpie；工具名由适配器内置常量给出（`GENERATE_IMAGE_TOOL`、`GENERATION_RESULT_TOOL`）。

下游写入：`generated_asset`（id、result_id、storage_key、file_name、mime_type、sort_order、width、height、
source_asset_id）。**新增 `source_asset_id`**：记录这张成品对应哪张原图，供界面按原图对照展示。

## 验收标准

| 编号 | 断言 | 自动化用例 |
| --- | --- | --- |
| AC-05-1 | 资源夹 3 张原图 → 任务发出 3 次 `generate_image`，每次 `n = 1` 且 `reference_images` 长度为 1，且与原图一一对应 | 单测（断言调用次数与每次入参） |
| AC-05-2 | 每个 `generated_asset.source_asset_id` 都能在原图集合里找到，且不重复 | 集成测试 |
| AC-05-3 | 传入上游的图片是压缩后的 JPEG、长边 ≤ 1536、以 data URL 形式放进 `reference_images` | 单测 |
| AC-05-4 | 只回作业 id 时轮询 `generation_result` 直到拿到图片，不重复触发绘制 | 单测 |
| AC-05-5 | 3 张中第 2 张失败：结果保留 2 张成品、`sort_order` 为 1 和 3，任务为 `partial`，错误里点名第 2 张原图 | 单测 |
| AC-05-6 | 落盘文件字节与上游给的内容一致（内联按 b64 解码结果，URL 按下载响应字节），`mime_type` 与回包 `mimeType` 或下载响应的 `content-type` 一致 | 集成测试 |
| AC-05-7 | 日志与阶段错误里不出现网关 key 与 base64 内容 | 单测（日志断言） |
| AC-05-9 | 任务快照里含提取目标原文与所选提取要求；提示词同时包含「提取目标：<原文>」与提取要求描述 | 单测 |
| AC-05-10 | 提取要求只剩 `faithful` / `flatten` / `dereflect` 三项，旧的视觉方向三项被拒绝 | 单测 |

## 验证方式

```bash
pnpm test
pnpm test:e2e    # mock 适配器跑通任务链路
```

真实连通（人工，一次性）：设置里配好 magpie 图片网关（`/mcp/magpie/image`）并选好生图模型；
在 sparkflow 里对一个 3 张原图的资源夹发起创作，确认 3 张成品分别对应 3 张原图、可预览、可下载。
若网关未配置或凭据无效，本项记阻塞，不得用 mock 结论替代。
