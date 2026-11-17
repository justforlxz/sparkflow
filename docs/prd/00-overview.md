# 拾光 · AI 内容工坊 — 产品总览

> 版本 1.1 ｜ 基线：V5 网页原型 + 需求确认（2026-11-17）｜ 本目录按功能拆分，一份文件对应一个可独立交付的功能点
>
> 术语以仓库根目录 `GLOSSARY.md` 为准；设计决策见 `docs/adr/`。

## 1. 产品定位

拾光是一款**个人自用**的 AI 图文内容创作工具。用户把从平台收集的图片与来源信息归档成媒体资源夹，
再通过配置好的图片创作 Agent 与文案创作 Agent，把素材加工成一组新的图片和配套文案，
最后自行发布到小红书。

产品负责「从素材整理到内容成稿」。它不发现热门内容，也不替你发布。

## 2. 第一版做什么

- 归档原始图片、来源链接、原始标题、原始文案。
- 同一资源夹可多次创作，不覆盖原始素材，也不覆盖历史结果。
- 用户配置模型网关、模型清单，以及两个 Agent 的提示词。
- 图片 Agent 调 magpie 的图片 MCP **按文字要求生成新图**。
- 文案 Agent 生成标题、正文、话题标签。
- 检查、编辑、整理并导出图文内容。
- 记录用户手动完成的小红书发布。
- **功能开关机制**：按功能粒度控制「这个版本能不能用」，设置页有真实开关。

## 3. 第一版明确不做

- 不开发 iOS / Android App。
- 不做自动爬取、热门内容发现、批量采集。
- 不做小红书自动发布、账号授权、接口对接。
- 不做通用可视化工作流编辑器。
- 不做多用户、团队协作、角色权限、多租户。
- 不做图片图层编辑器或通用设计工具。
- **不做图生图**：不把原始图片作为参考交给模型。所有相关入口点击后提示「该功能未启用」，
  由功能开关 `image-to-image` 控制，该开关在本版本**不可开启**（未实现）。
- **不做分享到小红书**：按钮保留，点击后站内提示「分享功能不可用」，不发起任何外部请求。

## 4. 核心概念

| 概念 | 含义 |
| --- | --- |
| 媒体资源夹 | 一次素材收集的归档单元，含来源信息与一组原始图片，可发起多次创作 |
| 创作任务 | 针对资源夹发起的一次加工，含两个执行阶段、参数快照、Agent 配置快照 |
| 执行阶段 | 任务内的可独立成败、可独立重跑的步骤：生图阶段、文案阶段 |
| 创作结果 | 一次任务产出的内容：生成图片 + 标题 + 正文 + 话题标签 |
| 网关 | 用户配置的模型服务入口：接口形状、Base URL、API Key、模型清单 |
| 模型条目 | 网关清单中的一项：模型 ID + 能力标签 |
| Agent 配置 | 两份固定配置：`image`、`copy` |
| 功能开关 | 按功能粒度控制是否可用的持久化开关，判定只有一个入口 |
| 发布记录 | 用户手动确认发布后留下的一条记录 |

## 5. 数据对象

| 对象 | 关键字段 | 关系 |
| --- | --- | --- |
| `media_collection` | id、name、platform、source_url、source_title、source_body、created_at、updated_at | 含多张原图、多个任务、多个结果 |
| `media_asset` | id、collection_id、file_name、storage_key、mime_type、size、sort_order、created_at | 原图；解除关联不等于删除文件 |
| `generation_task` | id、collection_id、visual_style、copy_style、image_count、extra_prompt、agent_snapshot、result_id、created_at | 归属一个资源夹；状态由阶段派生 |
| `generation_stage` | id、task_id、stage（image/copy）、status、attempts、error、started_at、finished_at | 一个任务两条；可独立重跑 |
| `generation_result` | id、task_id、collection_id、title、body、tags、visual_style、created_at | 一个任务最多一个 |
| `generated_asset` | id、result_id、storage_key、file_name、mime_type、sort_order | 归属一个结果 |
| `gateway` | id、name、protocol、base_url、encrypted_api_key、created_at、updated_at | 含多个模型条目 |
| `gateway_model` | id、gateway_id、model_id、capability | 同一网关内模型 ID 唯一 |
| `agent_config` | type（image/copy）、enabled、name、gateway_model_id、role、system_prompt、output_requirements、updated_at | 固定两条 |
| `feature_flag` | key、enabled、updated_at | key 取自代码里的注册表 |
| `publish_record` | id、result_id（唯一）、platform、published_at、title_snapshot、selected_asset_ids | 一个结果最多一条 |
| `user` | id、email（唯一，小写）、name、password_hash、created_at、last_login_at、disabled_at | 账号；第一版只有第一个注册的账号 |
| `session` | id、token_hash（唯一）、user_id、expires_at、revoked_at、user_agent | 会话；登出与改密码即时失效 |
| `app_meta` | key、value、updated_at | 结构版本等运行期元数据 |

## 6. 全局规则

1. 资源夹至少包含一张原始图片。
2. 原始素材永远不被生成结果覆盖。
3. 一个资源夹可以有多个任务；每个任务独立保留参数与配置快照。
4. 任务创建时固化 Agent 配置快照；之后改网关或提示词不影响已创建的任务。
5. 两个 Agent 都必须启用并绑定可用模型，才允许开始创作。
6. 被 Agent 引用的网关不允许直接删除。
7. 删除资源夹级联删除其任务、结果、发布记录，删除前二次确认。
8. 只有用户手动标记，才产生发布记录；系统不推断发布成功。
9. 文案生成禁止照搬原始文案、虚构参数或体验。
10. 所有列表、统计、状态来自真实业务数据，不使用演示数据。
11. 任何「本版本未实现」的能力，都必须通过功能开关判定，不允许在调用点自行写死。
12. 除 `/login`、`/api/health`、`/api/auth/*` 外，所有页面与接口都要求登录。

## 7. 非功能要求

- **持久化**：刷新页面、重启服务后，素材、图片、任务、配置、发布记录都存在。
- **升级兼容**：结构变更必须通过迁移文件交付，换镜像启动即完成升级。
- **文件安全**：校验类型与大小（以内容为准）；文件名不直接作为存储路径。
- **凭据与会话安全**：API Key 只在服务端加密保存；密码用 scrypt 派生；会话令牌只存其哈希；
  接口、日志、错误信息都不出现明文密钥、密码或令牌。
- **任务可靠性**：生成异步执行，不阻塞请求；重启后不留下永久「处理中」。
- **可追踪**：任务与阶段都能看到状态、失败原因、重试次数。
- **交互反馈**：上传、保存、删除、生成、重试、复制、下载、测试连接都有明确反馈。

## 8. 功能文档索引

| 文件 | 功能 |
| --- | --- |
| [01-media-collection.md](01-media-collection.md) | 媒体资源夹与原始文件 |
| [02-model-gateway.md](02-model-gateway.md) | 模型网关、模型清单与凭据安全 |
| [03-agent-config.md](03-agent-config.md) | 两个 Agent 配置与设置页 |
| [04-generation-task.md](04-generation-task.md) | 任务编排、阶段状态、重试 |
| [05-image-generation.md](05-image-generation.md) | 图片创作（文生图，magpie MCP） |
| [06-copy-generation.md](06-copy-generation.md) | 文案创作 |
| [07-results.md](07-results.md) | 任务与结果界面 |
| [08-publish.md](08-publish.md) | 发布准备、导出、发布记录 |
| [09-dashboard.md](09-dashboard.md) | 工作台与全局状态 |
| [10-feature-flags.md](10-feature-flags.md) | 功能开关机制与设置区块 |
| [11-accounts.md](11-accounts.md) | 账号与会话（登录、首个账号注册、密码重置） |

工程约束见 [../architecture.md](../architecture.md)，开发流程见 [../development.md](../development.md)，
验收规范见 [../acceptance.md](../acceptance.md)。
