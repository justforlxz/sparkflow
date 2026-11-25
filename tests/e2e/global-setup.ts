import pg from "pg";

/**
 * e2e 前置：清空账号与会话，让「首次注册」用例在空库上运行；
 * 并把图片提取 Agent 的网关绑定清空，让每条链路都从「未配置」的默认状态开始。
 *
 * 绑定在这一步清而不是用例内部：用例可能把 Agent 绑到随后被删掉的网关上，
 * 统一在这里回到「未绑定」比每条用例各写一份复原逻辑更稳。
 * 只对 DATABASE_URL 指向的库生效；CI 与本地 e2e 都指向测试库。
 */
export default async function setup(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("e2e 需要 DATABASE_URL");

  const pool = new pg.Pool({ connectionString });
  try {
    await pool.query('DELETE FROM "session"');
    await pool.query('DELETE FROM "user"');
    await pool.query('UPDATE "agent_config" SET "gateway_id" = NULL, "gateway_model_id" = NULL');
  } finally {
    await pool.end();
  }
}
