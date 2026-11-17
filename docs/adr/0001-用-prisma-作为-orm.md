# 0001 用 Prisma 作为数据库访问层

- 状态：已采纳（2026-11-17）
- 相关：数据库升级兼容、PR 评审

## 背景

项目要求 PostgreSQL、要求「数据库配置升级兼容」，且每个功能都以 PR 形式交付评审。
候选是 Prisma 与 Drizzle。

## 决策

使用 Prisma（稳定版 7.x）作为唯一 ORM：schema 是 `prisma/schema/` 下的单文件或多文件 schema，
迁移由 `prisma migrate` 生成并提交，生产由容器启动时 `prisma migrate deploy` 自动应用。

## 后果

- 收益：迁移历史与 `_prisma_migrations` 表是成熟机制；schema 与生成的类型一致，减少手写 DTO 漂移。
- 代价：多一个生成步骤（`prisma generate`）与一个运行时依赖 `@prisma/client`；
  镜像里需要带上生成产物，构建顺序不能乱。
- 注意：npm 上 `prisma` 的 `latest` 标签当前指向 8.0.0 的 RC，**不要**用 `latest`，
  显式钉稳定版（7.10.1）与同版本 `@prisma/adapter-pg`。

## 备选与放弃原因

- Drizzle：迁移是可读 SQL、无生成步骤，但团队既定选型为 Prisma，评审更熟悉 schema diff。
