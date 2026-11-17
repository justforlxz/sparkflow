import pg from "pg";

/**
 * e2e 前置：清空账号与会话，让「首次注册」用例在空库上运行。
 * 只对 DATABASE_URL 指向的库生效；CI 与本地 e2e 都指向测试库。
 */
export default async function setup(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("e2e 需要 DATABASE_URL");

  const pool = new pg.Pool({ connectionString });
  try {
    await pool.query('DELETE FROM "session"');
    await pool.query('DELETE FROM "user"');
  } finally {
    await pool.end();
  }
}
