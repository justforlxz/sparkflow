"use client";

import { useCallback, useState } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { buttonClass, noticeClass } from "@/components/ui/styles";
import {
  CONNECTION_FAILURE_LABELS,
  findCapability,
  findProtocol,
} from "@/modules/gateway/constants";
import type { ConnectionTestResult } from "@/modules/gateway/connection";
import type { GatewayView } from "@/modules/gateway/view";
import { GatewayDialog } from "./GatewayDialog";
import { fetchJson } from "./client";

type LoadState = "ready" | "error";

/** 失败类别文案只从模块常量取，界面不另存一份（AGENTS.md 硬性规则 1）。 */
function lastTestText(gateway: GatewayView): string {
  if (!gateway.lastTest) return "最近一次测试：未测试";
  const { ok, outcome, failureLabel, message } = gateway.lastTest;
  if (ok) return `最近一次测试：成功（${message}）`;

  const label =
    failureLabel ??
    (outcome in CONNECTION_FAILURE_LABELS
      ? CONNECTION_FAILURE_LABELS[outcome as keyof typeof CONNECTION_FAILURE_LABELS]
      : null);
  return `最近一次测试：${label ?? "失败"}（${message}）`;
}

/**
 * 设置页「网关」区块：列表、编辑弹窗、模型清单增删、能力标签、测试连接、删除确认、密钥显示/隐藏（在弹窗里）。
 * 只经 `/api/gateways` 系列接口读写，不直接碰数据库。
 */
export interface GatewaySectionProps {
  /** 首屏数据由服务端页面读好再传进来，客户端只负责交互后的刷新。 */
  initialGateways: GatewayView[];
}

export function GatewaySection({ initialGateways }: GatewaySectionProps) {
  const [gateways, setGateways] = useState<GatewayView[]>(initialGateways);
  const [state, setState] = useState<LoadState>("ready");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<GatewayView | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await fetchJson<{ gateways: GatewayView[] }>("/api/gateways");
      setGateways(body.gateways);
      setState("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载网关失败");
      setState("error");
    }
  }, []);

  function applyGateway(updated: GatewayView) {
    setGateways((current) =>
      current.some((gateway) => gateway.id === updated.id)
        ? current.map((gateway) => (gateway.id === updated.id ? updated : gateway))
        : [...current, updated],
    );
  }

  async function runTest(gateway: GatewayView) {
    setTestingId(gateway.id);
    setError(null);
    setNotice(null);
    try {
      const body = await fetchJson<{ result: ConnectionTestResult }>(
        `/api/gateways/${gateway.id}/test`,
        { method: "POST" },
      );
      setNotice(`${gateway.name}：${body.result.message}`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "测试连接失败");
    } finally {
      setTestingId(null);
    }
  }

  async function remove(gateway: GatewayView) {
    setError(null);
    setNotice(null);
    try {
      await fetchJson<{ deleted: string }>(`/api/gateways/${gateway.id}`, { method: "DELETE" });
      setConfirmingDelete(null);
      setNotice(`已删除网关 ${gateway.name}`);
      await load();
    } catch (cause) {
      setConfirmingDelete(null);
      setError(cause instanceof Error ? cause.message : "删除网关失败");
    }
  }

  return (
    <section aria-label="模型网关" className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-heading font-semibold text-ink">模型网关</h2>
          <p className="max-w-2xl text-body text-ink-secondary">
            你自己配置的模型服务入口：接口形状、Base URL、API Key 与模型清单。密钥加密保存，只显示掩码。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className={buttonClass({ variant: "primary" })}
        >
          新增网关
        </button>
      </div>

      {error ? <ErrorState message={error} /> : null}
      {notice ? (
        <p role="status" className={noticeClass("positive")}>
          {notice}
        </p>
      ) : null}

      {state === "ready" && gateways.length === 0 ? (
        <EmptyState message="还没有网关。先新增一个网关并填入模型清单，两个 Agent 才能从中选择模型。" />
      ) : null}

      <ul className="space-y-3">
        {gateways.map((gateway) => (
          <li key={gateway.id} data-testid="gateway-card" data-gateway-name={gateway.name}>
            <Panel bodyClassName="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-heading font-semibold text-ink">{gateway.name}</h3>
                    <Pill tone="neutral">
                      {findProtocol(gateway.protocol)?.label ?? gateway.protocol}
                    </Pill>
                  </div>
                  <code className="block break-all text-footnote text-ink-tertiary">{gateway.baseUrl}</code>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(gateway)}
                    className={buttonClass({ variant: "secondary", size: "sm" })}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => void runTest(gateway)}
                    disabled={testingId === gateway.id}
                    className={buttonClass({ variant: "secondary", size: "sm" })}
                  >
                    {testingId === gateway.id ? "测试中…" : "测试连接"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(gateway.id)}
                    className={buttonClass({ variant: "danger", size: "sm" })}
                  >
                    删除
                  </button>
                </div>
              </div>

              <dl className="grid gap-1 text-body text-ink-secondary sm:grid-cols-2">
                <div className="flex items-baseline gap-2">
                  <dt className="text-ink-tertiary">API Key</dt>
                  <dd data-testid="gateway-api-key-mask">
                    {gateway.apiKeyMask}
                    <span className="ml-2 text-caption text-ink-tertiary">
                      {gateway.hasApiKey ? "已保存" : "未设置"}
                    </span>
                  </dd>
                </div>
                <div className="flex items-baseline gap-2">
                  <dt className="text-ink-tertiary">模型数量</dt>
                  <dd>{gateway.models.length}</dd>
                </div>
              </dl>

              <div className="space-y-1">
                <p className="text-footnote text-ink-tertiary">模型清单</p>
                {gateway.models.length === 0 ? (
                  <p className="text-footnote text-ink-tertiary">暂无模型</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {gateway.models.map((model) => (
                      <li
                        key={model.id}
                        className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-footnote text-ink-secondary"
                      >
                        <code>{model.modelId}</code>
                        <span className="rounded-sm bg-soft px-1.5 py-0.5 text-caption text-ink-secondary">
                          {findCapability(model.capability)?.label ?? model.capability}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <p className="text-footnote text-ink-tertiary">{lastTestText(gateway)}</p>

              {gateway.references.length > 0 ? (
                <p className="text-footnote text-warning">
                  被 {gateway.references.map((reference) => reference.name).join("、")} 引用，不能删除
                </p>
              ) : null}

              {confirmingDelete === gateway.id ? (
                <div className={noticeClass("danger", "flex flex-wrap items-center gap-2")}>
                  <span className="text-body">确认删除网关 {gateway.name}？此操作不可恢复。</span>
                  <button
                    type="button"
                    onClick={() => void remove(gateway)}
                    className={buttonClass({ variant: "danger", size: "sm" })}
                  >
                    确认删除
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(null)}
                    className={buttonClass({ variant: "secondary", size: "sm" })}
                  >
                    取消
                  </button>
                </div>
              ) : null}
            </Panel>
          </li>
        ))}
      </ul>

      {creating ? (
        <GatewayDialog onClose={() => setCreating(false)} onChanged={applyGateway} />
      ) : null}
      {editing ? (
        <GatewayDialog
          gateway={editing}
          onClose={() => setEditing(null)}
          onChanged={applyGateway}
        />
      ) : null}
    </section>
  );
}
