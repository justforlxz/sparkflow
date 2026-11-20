"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/components/api";
import { ErrorState } from "@/components/ui/ErrorState";
import { buttonClass } from "@/components/ui/styles";
import { LoadingState } from "@/components/ui/LoadingState";
import type { AgentConfigView, AgentModelCandidate } from "@/modules/agent-config/view";
import { AgentCard, type AgentGatewayOption } from "./AgentCard";

export interface AgentSectionProps {
  /** 首屏数据由服务端页面读好再传进来，客户端只负责交互后的刷新。 */
  initialAgents: AgentConfigView[];
  /** 首屏可绑定的网关；刷新时重新读，新增或删掉的网关立刻在页面上可见。 */
  gatewayOptions: AgentGatewayOption[];
}

async function fetchCandidates(
  agents: readonly AgentConfigView[],
): Promise<Record<string, AgentModelCandidate[]>> {
  const entries = await Promise.all(
    agents.map(async (agent) => {
      const body = await fetchJson<{ models: AgentModelCandidate[] }>(
        `/api/agents/models?type=${agent.type}`,
      );
      return [agent.type, body.models] as const;
    }),
  );
  return Object.fromEntries(entries);
}

async function fetchGatewayOptions(): Promise<AgentGatewayOption[]> {
  const body = await fetchJson<{ gateways: { id: string; name: string }[] }>("/api/gateways");
  return body.gateways.map(({ id, name }) => ({ id, name }));
}

/**
 * 设置页「Agent」区块：图片 Agent 与文案 Agent 两张配置表单（docs/prd/03-agent-config.md）。
 * 区块之间不互相内联逻辑：这里只经各自接口读写，不让 Agent 区块去调用网关区块的组件。
 */
export function AgentSection({ initialAgents, gatewayOptions }: AgentSectionProps) {
  const [agents, setAgents] = useState<AgentConfigView[]>(initialAgents);
  const [gateways, setGateways] = useState<AgentGatewayOption[]>(gatewayOptions);
  const [candidates, setCandidates] = useState<Record<string, AgentModelCandidate[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetchCandidates(initialAgents)
      .then((next) => {
        if (!cancelled) setCandidates(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "加载模型候选失败");
      });

    return () => {
      cancelled = true;
    };
  }, [initialAgents]);

  /**
   * 网关与候选模型在打开页面时读一次。网关区块里刚加或刚删了网关，点这里重新读：
   * 单刷新模型不够 —— 下拉里的网关选项也来自首屏数据，不一起刷新会留下删不掉的旧选项。
   */
  async function refreshReferenceData() {
    setRefreshing(true);
    setError(null);
    try {
      const [nextGateways, nextCandidates] = await Promise.all([
        fetchGatewayOptions(),
        fetchCandidates(agents),
      ]);
      setGateways(nextGateways);
      setCandidates(nextCandidates);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载网关与模型清单失败");
    } finally {
      setRefreshing(false);
    }
  }

  function applyAgent(updated: AgentConfigView) {
    setAgents((current) =>
      current.map((agent) => (agent.type === updated.type ? updated : agent)),
    );
  }

  return (
    <section aria-label="Agent 配置" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-heading font-semibold text-ink">Agent</h2>
          <p className="max-w-2xl text-body text-ink-secondary">
            两个固定的创作 Agent。图片 Agent 的模型可以留空，表示用网关侧的默认图片模型；文案 Agent
            必须绑定模型。创建任务时按这里的配置固化成快照，之后修改不影响已创建的任务。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshReferenceData()}
          disabled={refreshing}
          className={buttonClass({ variant: "secondary" })}
        >
          {refreshing ? "加载中…" : "刷新网关与模型"}
        </button>
      </div>

      {error ? <ErrorState message={error} /> : null}
      {refreshing ? <LoadingState label="正在刷新网关与模型清单…" /> : null}

      <div className="space-y-4">
        {agents.map((agent) => (
          <AgentCard
            key={agent.type}
            agent={agent}
            gateways={gateways}
            candidates={candidates[agent.type] ?? []}
            onSaved={applyAgent}
          />
        ))}
      </div>
    </section>
  );
}
