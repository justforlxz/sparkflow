-- 下线「文案创作 Agent」类型（ADR 0012 第 3 条、MKACG-997）。
--
-- 文案与发布功能已在 20261125090000_drop_copy_and_publish 里删除，`agent_config` 里
-- type='copy' 的那一行只剩网关/模型绑定与提示词，没有任何功能读取它。
--
-- 只删这一行：type='image' 的图片提取 Agent 的配置（含绑定与提示词）原样保留，
-- 其它表也不动。`agent_config.type` 是主键，删除后不可恢复，回滚需要重新插入默认文案。

DELETE FROM "agent_config" WHERE "type" = 'copy';
