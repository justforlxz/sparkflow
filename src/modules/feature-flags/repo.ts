/** 功能开关的持久化访问。只读写 `feature_flag` 表，不在这里做可用性判断。 */
import { getDb } from "@/lib/db";

export async function listFlagRows(): Promise<Map<string, boolean>> {
  const rows = await getDb().featureFlag.findMany({ select: { key: true, enabled: true } });
  return new Map(rows.map((row) => [row.key, row.enabled]));
}

export async function findFlagRow(key: string): Promise<boolean | null> {
  const row = await getDb().featureFlag.findUnique({ where: { key }, select: { enabled: true } });
  return row ? row.enabled : null;
}

export async function setFlagRow(key: string, enabled: boolean): Promise<void> {
  await getDb().featureFlag.upsert({
    where: { key },
    create: { key, enabled },
    update: { enabled },
  });
}
