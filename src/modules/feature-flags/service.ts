/**
 * 功能开关的唯一判定入口：接口层调 `requireEnabled`，任务执行层调 `isEnabled`。
 * 每次调用都读数据库，不做进程内缓存 —— 开关变更立即生效。
 */
import { AppError } from "@/lib/errors";
import { findFlagRow, listFlagRows, setFlagRow } from "./repo";
import { FEATURE_FLAGS, findFeatureFlag, type FeatureFlagKey } from "./registry";
import { resolveFeatureFlag, type ResolvedFeatureFlag } from "./resolve";

function requireEntry(key: string) {
  const entry = findFeatureFlag(key);
  if (!entry) throw AppError.notFound(`未注册的功能开关：${key}`);
  return entry;
}

export async function listFeatures(): Promise<ResolvedFeatureFlag[]> {
  const rows = await listFlagRows();
  return FEATURE_FLAGS.map((entry) => {
    const enabled = rows.get(entry.key);
    return resolveFeatureFlag(entry, enabled === undefined ? null : { enabled });
  });
}

export async function getFeature(key: string): Promise<ResolvedFeatureFlag | undefined> {
  const entry = findFeatureFlag(key);
  if (!entry) return undefined;
  const enabled = await findFlagRow(entry.key);
  return resolveFeatureFlag(entry, enabled === null ? null : { enabled });
}

export async function isEnabled(key: FeatureFlagKey): Promise<boolean> {
  const entry = requireEntry(key);
  const enabled = await findFlagRow(entry.key);
  return resolveFeatureFlag(entry, enabled === null ? null : { enabled }).active;
}

export async function requireEnabled(key: FeatureFlagKey): Promise<void> {
  const entry = requireEntry(key);
  if (await isEnabled(key)) return;
  throw new AppError("CONFLICT", entry.disabledMessage, {
    details: { code: "FEATURE_DISABLED", feature: entry.key },
  });
}

/**
 * 设置开关。未实现的功能不允许开启（返回 `FEATURE_NOT_IMPLEMENTED`，且不写库）。
 * 关闭未实现的功能是允许的：它本来就是关的，只是清掉可能残留的行。
 */
export async function setFeatureEnabled(key: string, enabled: boolean): Promise<ResolvedFeatureFlag> {
  const entry = requireEntry(key);

  if (enabled && !entry.implemented) {
    throw AppError.validationFailed(`${entry.name}在本版本未实现，不能开启`, {
      code: "FEATURE_NOT_IMPLEMENTED",
      feature: entry.key,
    });
  }

  await setFlagRow(entry.key, enabled);
  return (await getFeature(entry.key)) as ResolvedFeatureFlag;
}
