/**
 * 数据库访问：客户端实例集中在这里，走 `@prisma/adapter-pg` 驱动适配器。
 * 结构版本（Schema Version）= `_prisma_migrations` 里已应用的迁移条数。
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "./env";

const globalForDb = globalThis as typeof globalThis & { sparkflowDb?: PrismaClient };

export function getDb(): PrismaClient {
  if (!globalForDb.sparkflowDb) {
    const { DATABASE_URL } = getEnv();
    globalForDb.sparkflowDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
  }
  return globalForDb.sparkflowDb;
}

export async function getSchemaVersion(): Promise<number> {
  const rows = await getDb().$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count
    FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  `;
  return Number(rows[0]?.count ?? 0);
}
