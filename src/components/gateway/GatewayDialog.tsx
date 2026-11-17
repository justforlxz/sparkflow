"use client";

import { useState } from "react";
import {
  GATEWAY_PROTOCOLS,
  MODEL_CAPABILITIES,
  findCapability,
  findProtocol,
} from "@/modules/gateway/constants";
import type { GatewayView } from "@/modules/gateway/view";
import { fetchJson } from "./client";

export interface GatewayDialogProps {
  /** 传了就是编辑，不传就是新增。 */
  gateway?: GatewayView;
  onClose: () => void;
  /** 保存或模型清单变化后把最新网关交回列表。 */
  onChanged: (gateway: GatewayView) => void;
}

const DEFAULT_PROTOCOL = GATEWAY_PROTOCOLS[0].value;

/**
 * 新增 / 编辑网关的弹窗：基本信息 + 密钥（可显示/隐藏）+ 模型清单增删。
 * 密钥输入框留空表示保留原密钥（docs/prd/02-model-gateway.md MUST 2）。
 */
export function GatewayDialog({ gateway, onClose, onChanged }: GatewayDialogProps) {
  const editing = Boolean(gateway);
  const [name, setName] = useState(gateway?.name ?? "");
  const [protocol, setProtocol] = useState<string>(gateway?.protocol ?? DEFAULT_PROTOCOL);
  const [baseUrl, setBaseUrl] = useState(gateway?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [models, setModels] = useState(gateway?.models ?? []);
  const [modelId, setModelId] = useState("");
  const [capability, setCapability] = useState<string>(MODEL_CAPABILITIES[0].value);
  const [saving, setSaving] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const protocolDefinition = findProtocol(protocol);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name,
        protocol,
        baseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      };
      const body = gateway
        ? await fetchJson<{ gateway: GatewayView }>(`/api/gateways/${gateway.id}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          })
        : await fetchJson<{ gateway: GatewayView }>("/api/gateways", {
            method: "POST",
            body: JSON.stringify({ ...payload, apiKey: apiKey.trim() }),
          });
      onChanged(body.gateway);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function addModel() {
    if (!gateway) return;
    setModelBusy(true);
    setError(null);
    try {
      const body = await fetchJson<{ gateway: GatewayView }>(`/api/gateways/${gateway.id}/models`, {
        method: "POST",
        body: JSON.stringify({ modelId, capability }),
      });
      setModels(body.gateway.models);
      setModelId("");
      onChanged(body.gateway);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "添加模型失败");
    } finally {
      setModelBusy(false);
    }
  }

  async function removeModel(target: string) {
    if (!gateway) return;
    setModelBusy(true);
    setError(null);
    try {
      const body = await fetchJson<{ gateway: GatewayView }>(
        `/api/gateways/${gateway.id}/models/${encodeURIComponent(target)}`,
        { method: "DELETE" },
      );
      setModels(body.gateway.models);
      onChanged(body.gateway);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "移除模型失败");
    } finally {
      setModelBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-black/40 p-6">
      <div
        role="dialog"
        aria-label={editing ? "编辑网关" : "新增网关"}
        className="w-full max-w-xl space-y-5 rounded-lg bg-white p-6 shadow-xl"
      >
        <h3 className="text-lg font-semibold text-zinc-900">{editing ? "编辑网关" : "新增网关"}</h3>

        <div className="space-y-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium text-zinc-800">网关名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-sm font-medium text-zinc-800">接口形状</span>
            <select
              value={protocol}
              onChange={(event) => setProtocol(event.target.value)}
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            >
              {GATEWAY_PROTOCOLS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}（{entry.usage}）
                </option>
              ))}
            </select>
            {protocolDefinition ? (
              <span className="block text-xs text-zinc-500">{protocolDefinition.endpoint}</span>
            ) : null}
          </label>

          <label className="block space-y-1">
            <span className="text-sm font-medium text-zinc-800">Base URL</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://magpie.example.com"
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
            />
          </label>

          <div className="space-y-1">
            <label className="block text-sm font-medium text-zinc-800" htmlFor="gateway-api-key">
              API Key
            </label>
            <div className="flex gap-2">
              <input
                id="gateway-api-key"
                data-testid="gateway-api-key"
                type={showApiKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="off"
                placeholder={
                  editing ? `留空表示保留原密钥（当前 ${gateway?.apiKeyMask}）` : "填入网关密钥"
                }
                className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => setShowApiKey((value) => !value)}
                className="shrink-0 rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-700"
              >
                {showApiKey ? "隐藏" : "显示"}
              </button>
            </div>
          </div>
        </div>

        {editing ? (
          <section aria-label="模型清单" className="space-y-2 border-t border-zinc-200 pt-4">
            <h4 className="text-sm font-medium text-zinc-800">模型清单</h4>
            {models.length === 0 ? (
              <p className="text-xs text-zinc-500">还没有模型。文本协议做连接测试前，需要一个「文本」能力的模型。</p>
            ) : (
              <ul className="space-y-1">
                {models.map((model) => (
                  <li
                    key={model.id}
                    className="flex items-center justify-between gap-2 rounded border border-zinc-200 px-3 py-2 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <code className="text-zinc-800">{model.modelId}</code>
                      <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                        {findCapability(model.capability)?.label ?? model.capability}
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={`移除模型 ${model.modelId}`}
                      onClick={() => void removeModel(model.modelId)}
                      disabled={modelBusy}
                      className="text-xs text-red-600 disabled:text-zinc-400"
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap items-end gap-2">
              <label className="flex-1 space-y-1">
                <span className="block text-xs text-zinc-600">模型 ID</span>
                <input
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                  className="w-full rounded border border-zinc-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="space-y-1">
                <span className="block text-xs text-zinc-600">能力</span>
                <select
                  value={capability}
                  onChange={(event) => setCapability(event.target.value)}
                  className="rounded border border-zinc-300 px-3 py-2 text-sm"
                >
                  {MODEL_CAPABILITIES.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void addModel()}
                disabled={modelBusy || modelId.trim().length === 0}
                className="rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-700 disabled:text-zinc-400"
              >
                添加模型
              </button>
            </div>
          </section>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-zinc-200 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-700"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:bg-zinc-400"
          >
            {editing ? "保存" : "创建网关"}
          </button>
        </div>
      </div>
    </div>
  );
}
