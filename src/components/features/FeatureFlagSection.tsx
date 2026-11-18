"use client";

import { useState } from "react";
import { fetchJson } from "@/components/api";
import type { ResolvedFeatureFlag } from "@/modules/feature-flags/resolve";

export interface FeatureFlagSectionProps {
  /** 首屏数据由服务端页面读好再传进来。 */
  initialFeatures: ResolvedFeatureFlag[];
}

const AVAILABLE_GROUP = "可用";
const UNIMPLEMENTED_GROUP = "本版本未实现";

/**
 * 设置页「功能开关」区块（docs/prd/10-feature-flags.md MUST 4、MUST 5，AC-10-6）。
 *
 * 首屏由服务端直接读注册表与生效值（与 `GET /api/features` 返回同一份数据），
 * 开关变更走 `PATCH /api/features/[key]`；
 * `implemented = false` 的项开关置灰并标注「本版本未实现」，不可操作。
 */
export function FeatureFlagSection({ initialFeatures }: FeatureFlagSectionProps) {
  const [features, setFeatures] = useState<ResolvedFeatureFlag[]>(initialFeatures);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const available = features.filter((feature) => feature.implemented);
  const unimplemented = features.filter((feature) => !feature.implemented);

  async function toggle(feature: ResolvedFeatureFlag, enabled: boolean) {
    setBusyKey(feature.key);
    setError(null);
    setNotice(null);
    try {
      const body = await fetchJson<{ feature: ResolvedFeatureFlag }>(
        `/api/features/${feature.key}`,
        { method: "PATCH", body: JSON.stringify({ enabled }) },
      );
      setFeatures((current) =>
        current.map((entry) => (entry.key === body.feature.key ? body.feature : entry)),
      );
      setNotice(`${body.feature.name}已${body.feature.active ? "开启" : "关闭"}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新开关失败");
    } finally {
      setBusyKey(null);
    }
  }

  function renderGroup(title: string, items: ResolvedFeatureFlag[]) {
    if (items.length === 0) return null;

    return (
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-zinc-800">{title}</h3>
        <ul className="space-y-2">
          {items.map((feature) => (
            <li
              key={feature.key}
              data-testid={`feature-flag-${feature.key}`}
              className="flex flex-wrap items-start justify-between gap-3 rounded border border-zinc-200 bg-white px-3 py-2"
            >
              <div className="space-y-1">
                <p className="text-sm font-medium text-zinc-900">{feature.name}</p>
                <p className="max-w-xl text-xs text-zinc-600">{feature.description}</p>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-zinc-500">{feature.active ? "生效中" : "未生效"}</span>
                {!feature.implemented ? (
                  <span
                    data-testid="feature-unimplemented"
                    className="rounded bg-zinc-100 px-2 py-0.5 text-zinc-600"
                  >
                    {UNIMPLEMENTED_GROUP}
                  </span>
                ) : null}
                <label className="flex items-center gap-1 text-sm text-zinc-700">
                  <input
                    type="checkbox"
                    checked={feature.enabled}
                    disabled={!feature.implemented || busyKey === feature.key}
                    onChange={(event) => void toggle(feature, event.target.checked)}
                  />
                  <span>开启</span>
                </label>
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <section aria-label="功能开关" className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-zinc-900">功能开关</h2>
        <p className="max-w-2xl text-sm text-zinc-600">
          按功能粒度控制这个版本能不能用。关闭时对应入口提示「该功能未启用」，接口也不会产生数据。
        </p>
      </div>

      {error ? (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      ) : null}

      {renderGroup(AVAILABLE_GROUP, available)}
      {renderGroup(UNIMPLEMENTED_GROUP, unimplemented)}
    </section>
  );
}
