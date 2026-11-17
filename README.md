# 拾光 · AI 内容工坊

面向个人使用的 AI 图文内容创作工具：把收集到的图片与来源信息整理成媒体资源夹，
用可配置的图片创作 Agent 与文案创作 Agent 生成一组新图与配套文案，整理后自行发布到小红书。

产品不发现热门内容，也不替你发布。

## 当前状态

**只有文档，没有代码。** 本项目按「先定契约，再按功能节点交付代码」推进：
本仓库先落地产品文档、架构约定与验收规范，然后每个功能由一个 Issue 走完整的
开发 → 评审 → 功能检测 → 合并流程。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [GLOSSARY.md](GLOSSARY.md) | 术语表（用词冲突时以它为准） |
| [docs/prd/00-overview.md](docs/prd/00-overview.md) | 产品总览、数据对象、全局规则 |
| [docs/prd/](docs/prd/) | 10 份功能文档，每份含设计契约与可执行验收标准 |
| [docs/architecture.md](docs/architecture.md) | 分层、横切点、扩展点 |
| [docs/development.md](docs/development.md) | devcontainer、命令、迁移、部署、备份 |
| [docs/acceptance.md](docs/acceptance.md) | 三层验收、每个功能的 spec、合并协议、全量验收 |
| [docs/adr/](docs/adr/) | 架构决策记录 |
| [AGENTS.md](AGENTS.md) | 给编码代理的仓库约定 |

## 技术栈（已定）

- Next.js（App Router）+ TypeScript，前后端同仓同进程
- PostgreSQL + Prisma（迁移随代码提交，换镜像即升级）
- 图片存本地磁盘（挂载卷），由鉴权路由读取
- 后台上传/生成任务用进程内 worker，不引入队列
- 账号登录：cookie + 数据库会话（登出与改密码即时失效），首次访问注册第一个账号
- Dockerfile + docker compose 部署；本地统一用 devcontainer
- 出图调用 magpie 的图片 MCP，本项目不实现生图模型

## 第一版边界

- 不开发 App、不做自动采集、不做自动发布、不做多用户。
- **图生图不做**：由功能开关 `image-to-image` 关闭，相关入口提示「该功能未启用」。
- **分享到小红书不做**：按钮保留，点击提示「分享功能不可用」。

## 交付方式

一个功能一条 Issue、一个 PR。合并由 PL 执行，合并前会在 PR 上追加一条
「验收记录」提交（见 [docs/acceptance.md](docs/acceptance.md) 第 4 节）。
