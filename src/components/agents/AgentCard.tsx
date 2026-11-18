"use client";

import { useState } from "react";
import { fetchJson } from "@/components/api";
import type { AgentConfigView, AgentModelCandidate } from "@/modules/agent-config/view";
import { findCapability } from "@/modules/gateway/constants";

export interface AgentGatewayOption {
  id: string;
  name: string;
}

export interface AgentCardProps {
  agent: AgentConfigView;
  /** 可绑定的网关（下拉选项）。 */
  gateways: readonly AgentGatewayOption[];
  /** 该类型可选的模型，已按能力过滤（docs/prd/03 MUST 2）。 */
  candidates: readonly AgentModelCandidate[];
  /** 保存或恢复默认后，把最新配置交回区块。 */
  onSaved: (agent: AgentConfigView) => void;
}

interface Draft {
  enabled: boolean;
  name: string;
  gatewayId: string;
  modelId: string;
  role: string;
  systemPrompt: string;
  outputRequirements: string;
}

function draftOf(agent: AgentConfigView): Draft {
  return {
    enabled: agent.enabled,
    name: agent.name,
    gatewayId: agent.gatewayId ?? "",
    modelId: agent.gatewayModelId ?? "",
    role: agent.role,
    systemPrompt: agent.systemPrompt,
    outputRequirements: agent.outputRequirements,
  };
}

/**
 * 绑定状态的界面说法：模型留空时直接用模块常量里的那句话（AC-03-3 要求显示
 * 「使用网关默认图片模型」），失效与未绑定的原因由下面的 `issues` 说明，不在这里另写一份。
 */
export function modelBindingText(agent: AgentConfigView): string {
  if (agent.gatewayModelId) return `模型：${agent.gatewayModelId}`;
  if (agent.gatewayId) return `模型：${agent.emptyModelLabel}`;
  return "模型：未设置";
}

/**
 * 一份 Agent 配置的表单卡片：启用、名称、网关与模型绑定、角色说明、系统提示词、输出要求。
 * 只经 `/api/agents` 系列接口读写，不直接碰数据库。
 */
export function AgentCard({ agent, gateways, candidates, onSaved }: AgentCardProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(agent));
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 草稿只由本卡片维护：保存与恢复默认都会用接口返回的最新配置覆盖它，
  // 因此不需要监听 props 再同步一次（也不会出现「回填把用户正在输入的内容冲掉」）。

  const modelOptions = candidates.filter((candidate) => candidate.gatewayId === draft.gatewayId);
  // 当前绑定的模型可能已从网关里移除：保留一个占位项，让下拉不静默跳到别的模型。
  const staleModel =
    draft.modelId && !modelOptions.some((option) => option.modelId === draft.modelId)
      ? draft.modelId
      : null;

  function changeGateway(nextGatewayId: string) {
    const stillAvailable = candidates.some(
      (candidate) => candidate.gatewayId === nextGatewayId && candidate.modelId === draft.modelId,
    );
    setDraft((current) => ({
      ...current,
      gatewayId: nextGatewayId,
      modelId: stillAvailable ? current.modelId : "",
    }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const body = await fetchJson<{ agent: AgentConfigView }>(`/api/agents/${agent.type}`, {
        method: "PATCH",
        body: JSON.stringify({
          enabled: draft.enabled,
          name: draft.name,
          gatewayId: draft.gatewayId || null,
          gatewayModelId: draft.modelId || null,
          role: draft.role,
          systemPrompt: draft.systemPrompt,
          outputRequirements: draft.outputRequirements,
        }),
      });
      setDraft(draftOf(body.agent));
      onSaved(body.agent);
      setNotice("已保存");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setResetting(true);
    setError(null);
    setNotice(null);
    try {
      const body = await fetchJson<{ agent: AgentConfigView }>(
        `/api/agents/${agent.type}/reset`,
        { method: "POST" },
      );
      setDraft(draftOf(body.agent));
      onSaved(body.agent);
      setConfirmingReset(false);
      setNotice("已恢复默认");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复默认失败");
    } finally {
      setResetting(false);
    }
  }

  return (
    <article
      aria-label={agent.label}
      data-testid={`agent-card-${agent.type}`}
      className="space-y-4 rounded-lg border border-zinc-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-zinc-900">{agent.label}</h3>
          <p className="max-w-xl text-sm text-zinc-600">{agent.description}</p>
        </div>
        <span
          data-testid="agent-ready-badge"
          className={
            agent.ready
              ? "rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700"
              : "rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600"
          }
        >
          {agent.ready ? "就绪" : "未就绪"}
        </span>
      </div>

      <label className="flex items-center gap-2 text-sm text-zinc-800">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) =>
            setDraft((current) => ({ ...current, enabled: event.target.checked }))
          }
        />
        <span>启用</span>
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-zinc-800">名称</span>
        <input
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-sm font-medium text-zinc-800">网关</span>
          <select
            data-testid="agent-gateway"
            value={draft.gatewayId}
            onChange={(event) => changeGateway(event.target.value)}
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="">未绑定网关</option>
            {gateways.map((gateway) => (
              <option key={gateway.id} value={gateway.id}>
                {gateway.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-zinc-800">模型</span>
          <select
            data-testid="agent-model"
            value={draft.modelId}
            onChange={(event) => setDraft((current) => ({ ...current, modelId: event.target.value }))}
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="">{agent.emptyModelLabel}</option>
            {modelOptions.map((candidate) => (
              <option key={`${candidate.gatewayId}:${candidate.modelId}`} value={candidate.modelId}>
                {candidate.modelId}（{findCapability(candidate.capability)?.label ?? candidate.capability}）
              </option>
            ))}
            {staleModel ? (
              <option value={staleModel}>{staleModel}（当前绑定，已失效）</option>
            ) : null}
          </select>
        </label>
      </div>

      <div className="space-y-1 text-sm">
        <p data-testid="agent-binding-state" className="text-zinc-700">
          {modelBindingText(agent)}
        </p>
        {agent.issues.length > 0 ? (
          <ul className="space-y-0.5 text-xs text-amber-600">
            {agent.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-zinc-800">角色说明</span>
        <textarea
          value={draft.role}
          onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))}
          rows={2}
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-zinc-800">系统提示词</span>
        <textarea
          value={draft.systemPrompt}
          onChange={(event) =>
            setDraft((current) => ({ ...current, systemPrompt: event.target.value }))
          }
          rows={3}
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-zinc-800">输出要求</span>
        <textarea
          value={draft.outputRequirements}
          onChange={(event) =>
            setDraft((current) => ({ ...current, outputRequirements: event.target.value }))
          }
          rows={2}
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
        />
      </label>

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-emerald-700">
          {notice}
        </p>
      ) : null}

      {confirmingReset ? (
        <div className="space-y-2 rounded border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-sm text-amber-800">
            恢复默认会重置名称、角色说明、系统提示词与输出要求，模型绑定保持不变。
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void reset()}
              disabled={resetting}
              className="rounded bg-amber-600 px-3 py-1.5 text-sm text-white disabled:bg-amber-300"
            >
              确认恢复
            </button>
            <button
              type="button"
              onClick={() => setConfirmingReset(false)}
              className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-zinc-200 pt-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:bg-zinc-400"
        >
          保存
        </button>
        <button
          type="button"
          onClick={() => setConfirmingReset(true)}
          className="rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-700"
        >
          恢复默认
        </button>
      </div>
    </article>
  );
}
