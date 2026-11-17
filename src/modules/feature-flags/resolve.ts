/**
 * 生效规则（纯函数，可单测）：
 * 实际可用 = 注册表.implemented && (数据库.enabled ?? 注册表.defaultEnabled)
 * `implemented = false` 的功能永远不可用，即使有人直接改数据库。
 */
import type { FeatureFlagEntry, FeatureFlagKey } from "./registry";

export interface FeatureFlagRowValue {
  enabled: boolean;
}

export interface ResolvedFeatureFlag {
  key: FeatureFlagKey;
  name: string;
  description: string;
  implemented: boolean;
  defaultEnabled: boolean;
  /** 数据库取值；缺行时取注册表默认值。 */
  enabled: boolean;
  /** 实际可用。 */
  active: boolean;
  affects: readonly string[];
  disabledMessage: string;
}

export function resolveFeatureFlag(
  entry: FeatureFlagEntry,
  row: FeatureFlagRowValue | null | undefined,
): ResolvedFeatureFlag {
  const enabled = row?.enabled ?? entry.defaultEnabled;
  return {
    key: entry.key as FeatureFlagKey,
    name: entry.name,
    description: entry.description,
    implemented: entry.implemented,
    defaultEnabled: entry.defaultEnabled,
    enabled,
    active: entry.implemented && enabled,
    affects: entry.affects,
    disabledMessage: entry.disabledMessage,
  };
}
