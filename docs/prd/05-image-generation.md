# 05 图片提取（从场景里取出目标，一图对一图，走 magpie 的 REST 出图接口）

> 依赖：02 网关、03 Agent 配置、04 任务编排、10 功能开关 ｜ 对端：magpie 插件 `magpie-image-edit`

## 目标

把资源夹里的**每一张原始图片**按**类别**取出目标，做成可以直接使用的素材：
一张原图 × 一个类别 = 一条素材，产物进「素材库」（`docs/prd/12-asset-library.md`）。

内置类别（ADR 0011）。每个类别带**两份描述**，分别给用户与生图模型看，**不得共用同一段文本**（MKACG-1000）：

- **界面说明**渲染在资源夹详情右栏「提取设置」→「固定三类」列表里：一句简短中文，
  **不得**出现 `orthographic` / `zero perspective` / `zero foreshortening` /
  `exactly horizontal or vertical` / `This is a material texture, not a scene` 这类提示词工程术语；
- **提取目标描述**拼进生图提示词：写可判定的几何约束（AC-PROMPT-1、AC-PROMPT-2）。

| key | 中文 | 界面说明 | 提取目标描述（进提示词） |
| --- | --- | --- | --- |
| `topdown` | 桌面俯视图 | 从正上方看桌面或桌垫的完整画面，去掉摆件与杂物，被遮挡处按周围材质补全 | 完美平整的俯视图（perfectly flat orthographic view，zero perspective，zero foreshortening）；所有长边与纹理走向必须 exactly horizontal or vertical；均匀漫射光，no shadows、无高光、无景深；去掉桌面上的摆件与杂物，被遮挡处按周围材质补全；保持桌面自身的长宽比，不拉伸、不裁切 |
| `texture` | 基本纹理 | 只取重复出现的那一块纹理单元，纹理均匀、四边可拼接，不出现桌垫边缘与场景 | 只取重复出现的那一块纹理单元，四边可无缝拼接（matching opposite edges）；这是材质不是场景（This is a material texture, not a scene）；perfectly flat orthographic view，zero perspective，zero foreshortening；所有线与纹理走向必须 exactly horizontal or vertical；均匀漫射光，no shadows、无高光；不要出现桌垫边缘与场景；保持纹理自身的长宽比，不拉伸、不裁切 |
| `graphic` | 形象设计 | 只取印刷在桌垫上的图案（卡通人物、插画、物品），正面平视、背景干净 | 只取印刷在桌垫上的图案（卡通人物、插画、物品），单一主体、正面平视（front-on orthographic view，zero perspective，zero foreshortening）；图案里的横线与竖线必须 exactly horizontal or vertical，不倾斜；完整保留图案的原始轮廓；均匀漫射光，no shadows、无高光、无倒影；纯色背景，去掉桌垫边缘与场景；保持图案自身的长宽比，不补画、不拉伸、不裁切 |

**有就提取，没有就不提取**：每个（原图 × 类别）先用视觉模型判定是否存在，不存在记 `skipped`，
不发起图生图（ADR 0011 第 2 条）。

「提取」不是「重绘」：重绘乐于改变与美化，提取要求**不改结构、只搬运**——
忠实保留目标自身的纹理、材质、图案与颜色，把与目标无关的场景元素全部去掉。

**本项目不实现图片生成模型，也不实现图生图逻辑**：全部经由 magpie 的 REST 出图接口完成
（图生图 `POST /v1/images/edits`，见「上游接口事实」）。

## 上游接口事实（2026-11-26 对线上 endpoint 实测）

出图走 magpie 的 **OpenAI 兼容 REST**：`POST <baseUrl>/v1/images/edits`（图生图）。
纯文生图的 `/v1/images/generations` 同样可用（同一套 `watermark: false`），但本版本没有文生图入口，
不实现那条调用路径 —— 需要时只是换一个路径常量。

端点是现有网关 `baseUrl` 上的另一条路由（线上 `https://magpie.mkacg.com`），用同一个密钥，
网关 `protocol` 仍是 `magpie-mcp`（连接测试仍走那条 MCP 端点），**用户不需要重新配置网关**（AC-REST-6）。

图生图的请求体（一图对一图）：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `prompt` | 拼装好的提示词 | 见「设计契约」 |
| `n` | `1` | ADR 0008 一图对一图 |
| `size` | `<宽>x<高>` | 必须 32 的倍数、∈[512,4096]、比例 ≤3:1（`deriveExtractionSize`） |
| `images` | `[{ image_url: <data URL> }]` | 原图压缩后内联，只放那一张 |
| `watermark` | `false` | **关掉上游水印的唯一开关** |
| `response_format` | `"b64_json"` | 要内联字节；只回 `url` 时适配器立刻取回 |
| `model` | 快照里的模型名；留空则省略整个字段 | 省略时用网关侧默认图片模型 |

回包：`{ created, data: [{ b64_json, mime_type, url? }], model, usage }`。

要点：

- **同步**：实测单张 31–208 秒（1536×1536，含上游排队），成功直接回 200 + b64；
  没有作业 id，**不需要轮询**。
- 单次请求超时 5 分钟（实测最长值的 1.4 倍以上）；调用发生在提取 worker 里，
  不经过 Next.js 的路由处理，不触发热 route 超时。
- 失败分类沿用 `IMAGE_ERROR_CODES`：401/403 → `UPSTREAM_AUTH`；5xx 与网络超时 → `UPSTREAM_TIMEOUT`；
  其余 4xx（含「模型不存在」）→ `UPSTREAM_REJECTED`；回包结构不对 → `UPSTREAM_FORMAT`。
- 上游原文只进日志；界面摘要由 `describeImageRejection` 说成中文（MKACG-902）。

### 水印（实测结论，2026-11-26，MKACG-1008）

sensenova 出图右下角带「日日新 / senseNova」水印。**根因不是模型，是通道**：
MCP `generate_image` 的工具 schema 里**没有** `watermark` 字段（可用参数只有 background、complexity、
model、n、prompt、quality、reference_images、resolution、size），传了被静默丢弃。

| 通道 | 结果 |
| --- | --- |
| MCP `generate_image` + `watermark: false` | 200，成品**水印仍在**（字段被丢） |
| REST `/v1/images/generations` + `watermark: false` | 200，**无水印** |
| REST `/v1/images/edits` + `watermark: false`（图生图的真实通道） | 200，**无水印** |

像素核验（纯色输入，统计右下角与背景色有差异的像素占比）：

| 请求 | 右下角非背景像素 |
| --- | --- |
| `watermark: false` | `0.00%` |
| 不传 `watermark` | `6.45%` |

因此：

- 出图**必须**走 REST 并固定带 `watermark: false`；原先「作业 id + 轮询」的路径不再存在。
- **不再做裁切后处理**（MKACG-1004 的 `watermark.ts`）：`watermark: false` 生效后它只会白损失一条
  真实内容（无条件裁掉底部 10% 再补回）。代码与安全检测保留作兜底，**默认不注入、默认不执行**。
- 不要指望提示词：实测同模型下把「不要水印」写进提示词无效。
- 界面的水印说明文案保留（下一节）：用户可能换成一个不支持关水印的模型。
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
| `flatten` | 平整化 | 压平褶皱、折痕与光照不均，让纹理均匀平整，可直接当材质使用 |
| `dereflect` | 去反光 | 去掉高光、反光与边缘阴影，还原目标真实的颜色与明暗 |

### 输出形态

固定为**去透视的平铺素材图**（MKACG-1000）：

- 画面里只有目标本身，没有桌面、道具、背景或场景阴影；
- 几何约束用**可判定的词**写：`perfectly flat orthographic view`、`zero perspective`、
  `zero foreshortening`；目标内的长线、格线与纹理走向必须 `exactly horizontal or vertical`；
  均匀漫射光，`no shadows`、无高光、无景深线索；
- **保持目标自身的真实长宽比**，目标之外留纯色空边即可；**不得**为了填满画布而拉伸或裁切
  （画布比例按原照片推导，见 `deriveExtractionSize`；命令模型「铺满画面」等于命令它拉伸）；
- 不添加原图里没有的文字、水印或标识；
- 收尾一句框定产品属性：`This is a material texture, not a scene.`

### 材质描述（两段式提示词的第一段）

图生图之前先用 `magpie-vision` 对**同一张原图**要一句材质与图案描述，作为 `Material: ...` 段
拼进生图提示词（同类纹理提取流水线的通行做法：先描述材质，再把「描述 + 原图」交给图生图）。

- 拿不到描述（没有理解网关、上游报错、回复空白）就**跳过该段**，不记失败、不阻断提取；
- 提问带固定标记（`MATERIAL_PROMPT_MARK`），mock 适配器据此把这类调用与「存在判定」分开，
  不占用 `mock:vision-absent-at-<n>` 的判定序号。

### MUST

1. 适配器接口 `ImageGenerator.generate(input) => Promise<GeneratedImage[]>`；
   实现 `MagpieImageGenerator`，只依赖 REST 端点与回包结构，不依赖具体模型。
2. **一图对一图**：资源夹有 N 张原图，就发 N 次 `POST /v1/images/edits`，每次 `n = 1` 且
   `images` 只放那一张原图；成品按原图顺序写入 `sort_order`。
3. **单任务内完成全部原图**，不拆成多个任务、不分批；一张失败不影响其它张继续。
4. 原图传给上游前压缩：长边不超过 1536，转 JPEG（质量 85），以 **data URL**
   （`data:image/jpeg;base64,...`）放进 `images[].image_url`。
5. 调用是**同步**的：单次请求超时 5 分钟（`DEFAULT_REQUEST_TIMEOUT_MS`），超时按 `UPSTREAM_TIMEOUT`
   记到条目上，可重试、不静默。不在适配器里盲目重试（一次调用已经几十秒到几分钟，
   而阶段总超时 45 分钟是硬上限）；重试由结果格上的「重试」重跑那一格（ADR 0005）。
6. `mimeType` 以回包为准（不写死 png；内联取 `data[].mime_type`，URL 取下载响应的
   `content-type`）；`bytes` 与实际落盘大小不一致时按落盘大小记录。
7. 失败如实记录到阶段 `error`：把失败的原图 id 与原因列出，阶段状态按 04 判定（部分成功即 `partial`）。
8. 不修改、不移动、不覆盖原始图片。
9. 记录每次调用的模型名与耗时；**不记录**网关 key、base64 图片内容。

### SHOULD

- 提示词 = Agent 快照的 role / systemPrompt / outputRequirements + **提取目标** + `Material` 材质描述
  + 提取要求描述 + 补充要求；拼装函数单独成函数并有单测。
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

上游：magpie 的 OpenAI 兼容 REST，`POST <baseUrl>/v1/images/edits`（config 的 `baseUrl` 指向 magpie，
线上 `https://magpie.mkacg.com`）。网关 `protocol` 仍为 `magpie-mcp` —— REST 与 MCP 是同一台网关上的
两条路由，共用地址与密钥，所以不需要新增协议值，也不需要用户重新配置（AC-REST-6）。
路径、`watermark: false`、`response_format` 由适配器内置常量给出
（`IMAGES_EDITS_PATH`、`WATERMARK_PARAM`、`RESPONSE_FORMAT`）。

下游写入：`generated_asset`（id、result_id、storage_key、file_name、mime_type、sort_order、width、height、
source_asset_id）。**新增 `source_asset_id`**：记录这张成品对应哪张原图，供界面按原图对照展示。

## 验收标准

| 编号 | 断言 | 自动化用例 |
| --- | --- | --- |
| AC-05-1 | 资源夹 3 张原图 → 任务发出 3 次 `POST /v1/images/edits`，每次 `n = 1` 且 `images` 长度为 1，且与原图一一对应 | 单测（断言调用次数与每次入参） |
| AC-05-2 | 每个 `generated_asset.source_asset_id` 都能在原图集合里找到，且不重复 | 集成测试 |
| AC-05-3 | 传入上游的图片是压缩后的 JPEG、长边 ≤ 1536、以 data URL 形式放进 `images[].image_url` | 单测 |
| AC-05-4 | 回包只给 `url` 时立刻下载取回字节，并按下载响应的 `content-type` 记录；下载回来不是图片时记 `UPSTREAM_FORMAT` | 单测 |
| AC-05-5 | 3 张中第 2 张失败：结果保留 2 张成品、`sort_order` 为 1 和 3，任务为 `partial`，错误里点名第 2 张原图 | 单测 |
| AC-05-6 | 落盘文件字节与上游给的内容一致（内联按 b64 解码结果，URL 按下载响应字节），`mime_type` 与回包 `mimeType` 或下载响应的 `content-type` 一致 | 集成测试 |
| AC-05-7 | 日志与阶段错误里不出现网关 key 与 base64 内容 | 单测（日志断言） |
| AC-05-9 | 任务快照里含提取目标原文与所选提取要求；提示词同时包含「提取目标：<原文>」与提取要求描述 | 单测 |
| AC-05-10 | 提取要求只剩 `faithful` / `flatten` / `dereflect` 三项，旧的视觉方向三项被拒绝 | 单测 |
| AC-REST-1 | 出图请求固定带 `watermark: false`，走 `<baseUrl>/v1/images/edits`，一图对一图；三类提取产物无水印 | 单测（请求体）+ 人工像素核验 |
| AC-REST-2 | 产物尺寸仍满足 32 的倍数 / ∈[512,4096] / 比例 ≤3:1，且长宽比与推导一致 | 人工实测 + 单测（`deriveExtractionSize`） |
| AC-REST-3 | 裁切后处理默认不执行：产物底部条带内容与生成图一致，不被替换成纯色 | 单测 + e2e |
| AC-REST-4 | 单次请求超时 5 分钟；超时/鉴权/被拒/格式各自分类，原因可读、可重试、不静默 | 单测 |
| AC-REST-5 | `pnpm check` / `test:integration` / `test:e2e` 全过；mock 适配器行为不变 | 命令 |
| AC-REST-6 | 网关协议值仍是 `magpie-mcp`，用户不需要重新配置网关 | 单测（`resolveImageGenerator`）+ 人工 |

## 验证方式

```bash
pnpm test
pnpm test:e2e    # mock 适配器跑通任务链路
```

真实连通（人工，一次性）：设置里配好 magpie 图片网关（`baseUrl` 指向 magpie，协议 `magpie-mcp`），
生图模型留空即用网关侧默认模型；在 sparkflow 里对一个 3 张原图的资源夹发起创作，
确认 3 张成品分别对应 3 张原图、**右下角没有「日日新 / senseNova」水印**、可预览、可下载，并记录单张耗时。
若网关未配置或凭据无效，本项记阻塞，不得用 mock 结论替代。
