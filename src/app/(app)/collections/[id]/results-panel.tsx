"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchJson } from "@/components/api";
import { RESULT_COPY } from "@/modules/generation/constants";
import type { ResultView } from "@/modules/generation/view";
import { VISUAL_STYLES } from "@/modules/image-generation/styles";
import { PUBLISH_COPY } from "@/modules/publish/constants";
import { parseTagInput } from "@/modules/publish/text";
import type { PublishRecordView } from "@/modules/publish/view";
import { PublishDialog } from "./publish-dialog";

/**
 * 「AI 创作结果」页签（docs/prd/07「结果页签」）：
 * 1. 按创建时间倒序（服务端已排好）：图片网格可点开大图、标题、正文、标签、视觉风格、生成日期。
 * 2. `partial` 结果在文案区域给出「文案阶段失败」提示与重试入口，不留空白（AC-08-11）。
 * 3. 编辑结果原地更新，不改动原始素材与其它结果（AC-07-6）。
 * 4. 删除整组结果前二次确认，文案写明发布记录会一并删除（AC-07-7）。
 * 5. 每张结果卡展示发布状态与「发布准备」入口；「分享到小红书」由页面用 `<FeatureGate>`
 *    渲染后作为 `shareEntry` 传入，客户端组件里不判断功能开关（docs/prd/10 MUST 3）。
 */

interface ResultsPanelProps {
  results: ResultView[];
  /** 已经有发布记录的结果 id，由服务端查询后传入（不在前端推断，docs/prd/07 MUST NOT）。 */
  publishedResultIds: string[];
  /** 功能开关渲染好的分享入口（关闭时是不可操作的占位按钮）。 */
  shareEntry: React.ReactNode;
}

interface ResultEnvelope {
  result: ResultView;
}

interface EditForm {
  title: string;
  body: string;
  tags: string;
  visualStyle: string;
}

/**
 * 标签输入框的解析与格式化在发布模块里（`publish/text.ts`）：发布准备弹窗也要用同一套规则，
 * 两处不能各写一份「去 `#`、去重复」。
 */

function toForm(result: ResultView): EditForm {
  return {
    title: result.title ?? "",
    body: result.body ?? "",
    tags: result.tags.join("，"),
    visualStyle: result.visualStyle,
  };
}

export function ResultsPanel({
  results: serverResults,
  publishedResultIds,
  shareEntry,
}: ResultsPanelProps) {
  const router = useRouter();
  /* 本地只记「改过的」与「删掉的」，列表由服务端数据派生：
   * `router.refresh()` 之后服务端数据更新，界面自然跟着变，不需要在 effect 里同步 state。 */
  const [patched, setPatched] = useState<Record<string, ResultView>>({});
  const [removed, setRemoved] = useState<string[]>([]);
  const results = serverResults
    .filter((result) => !removed.includes(result.id))
    .map((result) => patched[result.id] ?? result);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<ResultView | null>(null);
  const [form, setForm] = useState<EditForm | null>(null);
  const [deleting, setDeleting] = useState<ResultView | null>(null);
  const [publishing, setPublishing] = useState<ResultView | null>(null);
  const [justPublished, setJustPublished] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const isPublished = (resultId: string): boolean =>
    publishedResultIds.includes(resultId) || justPublished.includes(resultId);

  function openEdit(result: ResultView) {
    setEditing(result);
    setForm(toForm(result));
    setError(null);
  }

  async function saveEdit() {
    if (!editing || !form) return;
    setBusy(true);
    setError(null);
    try {
      const data = await fetchJson<ResultEnvelope>(`/api/results/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: form.title.trim(),
          body: form.body.trim(),
          tags: parseTagInput(form.tags),
          visualStyle: form.visualStyle,
        }),
      });
      setPatched((current) => ({ ...current, [data.result.id]: data.result }));
      setEditing(null);
      setForm(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : RESULT_COPY.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await fetchJson<{ id: string }>(`/api/results/${deleting.id}`, { method: "DELETE" });
      setRemoved((current) => [...current, deleting.id]);
      setDeleting(null);
      // 资源夹头部的结果计数也要跟着变。
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : RESULT_COPY.deleteFailed);
    } finally {
      setBusy(false);
    }
  }

  async function retryCopy(result: ResultView) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // 只重试失败的文案阶段（ADR 0005）：生图阶段与已有图片都不动。
      await fetchJson(`/api/tasks/${result.taskId}/retry`, { method: "POST" });
      setNotice("文案阶段已重新排队，完成后刷新页面查看。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : RESULT_COPY.retryFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          {notice}
        </p>
      ) : null}

      <ul className="space-y-4">
        {results.map((result) => (
          <li
            key={result.id}
            data-testid="result-card"
            data-result-id={result.id}
            className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4"
          >
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {result.assets.map((asset) => (
                <li key={asset.id}>
                  <a
                    href={asset.url}
                    target="_blank"
                    rel="noreferrer"
                    title={RESULT_COPY.openLarge}
                    className="block"
                  >
                    {/* 鉴权路由读取生成图片缩略图，不走 Next 图片优化器。 */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={asset.thumbnailUrl}
                      alt={asset.fileName}
                      className="h-32 w-full rounded border border-zinc-200 object-cover"
                    />
                  </a>
                </li>
              ))}
            </ul>

            <div className="space-y-2 text-sm">
              {/* 失败提示只是附加说明：手动补写过的标题 / 正文 / 标签必须照常显示（docs/prd/07 MUST 1）。 */}
              {result.copyFailed ? (
                <div className="space-y-2 rounded border border-amber-200 bg-amber-50 p-3">
                  <p data-testid="copy-failed-hint" className="text-amber-800">
                    {RESULT_COPY.copyFailedHint}
                  </p>
                  <button
                    type="button"
                    data-testid="copy-retry-button"
                    onClick={() => retryCopy(result)}
                    disabled={busy}
                    className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-60"
                  >
                    {RESULT_COPY.retryAction}
                  </button>
                </div>
              ) : null}

              {result.title ? (
                <h3 data-testid="result-title" className="text-base font-semibold text-zinc-900">
                  {result.title}
                </h3>
              ) : null}
              {result.body ? (
                <p
                  data-testid="result-body"
                  className="whitespace-pre-wrap break-words text-zinc-700"
                >
                  {result.body}
                </p>
              ) : null}
              {result.tags.length > 0 ? (
                <p data-testid="result-tags" className="text-xs text-zinc-500">
                  {result.tags.map((tag) => `#${tag}`).join(" ")}
                </p>
              ) : null}

              <p className="text-xs text-zinc-500">
                {result.visualStyleLabel} · {RESULT_COPY.generatedAtLabel}{" "}
                {result.createdAt.slice(0, 10)} · {RESULT_COPY.imageCountLabel}{" "}
                {result.assets.length} 张 ·{" "}
                {/* 发布状态由服务端查到的记录决定，前端不推断（docs/prd/07 MUST NOT）。 */}
                <span
                  data-testid="publish-status"
                  className={isPublished(result.id) ? "text-emerald-600" : undefined}
                >
                  {isPublished(result.id)
                    ? PUBLISH_COPY.statusPublished
                    : PUBLISH_COPY.statusUnpublished}
                </span>
              </p>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="publish-prepare"
                  onClick={() => {
                    setPublishing(result);
                    setError(null);
                    setNotice(null);
                  }}
                  className="rounded bg-zinc-900 px-3 py-1.5 text-white hover:bg-zinc-700"
                >
                  {PUBLISH_COPY.prepareAction}
                </button>
                <button
                  type="button"
                  data-testid="edit-result"
                  onClick={() => openEdit(result)}
                  className="rounded border border-zinc-300 px-3 py-1.5 text-zinc-700 hover:bg-zinc-100"
                >
                  {RESULT_COPY.editAction}
                </button>
                <button
                  type="button"
                  data-testid="delete-result"
                  onClick={() => {
                    setDeleting(result);
                    setError(null);
                  }}
                  className="rounded border border-red-300 px-3 py-1.5 text-red-700 hover:bg-red-50"
                >
                  {RESULT_COPY.deleteAction}
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {editing && form ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-6">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={RESULT_COPY.editTitle}
            className="w-full max-w-lg space-y-4 rounded-lg bg-white p-6 shadow-xl"
          >
            <h2 className="text-lg font-semibold text-zinc-900">{RESULT_COPY.editTitle}</h2>

            <div className="space-y-3 text-sm">
              <label className="block space-y-1">
                <span className="block font-medium text-zinc-900">{RESULT_COPY.titleLabel}</span>
                <input
                  aria-label={RESULT_COPY.titleLabel}
                  value={form.title}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                  className="w-full rounded border border-zinc-300 px-3 py-2"
                />
              </label>
              <label className="block space-y-1">
                <span className="block font-medium text-zinc-900">{RESULT_COPY.bodyLabel}</span>
                <textarea
                  aria-label={RESULT_COPY.bodyLabel}
                  rows={6}
                  value={form.body}
                  onChange={(event) => setForm({ ...form, body: event.target.value })}
                  className="w-full rounded border border-zinc-300 px-3 py-2"
                />
              </label>
              <label className="block space-y-1">
                <span className="block font-medium text-zinc-900">{RESULT_COPY.tagsLabel}</span>
                <input
                  aria-label={RESULT_COPY.tagsLabel}
                  value={form.tags}
                  onChange={(event) => setForm({ ...form, tags: event.target.value })}
                  className="w-full rounded border border-zinc-300 px-3 py-2"
                />
                <span className="block text-xs text-zinc-500">{RESULT_COPY.tagsHint}</span>
              </label>
              <label className="block space-y-1">
                <span className="block font-medium text-zinc-900">
                  {RESULT_COPY.visualStyleLabel}
                </span>
                <select
                  aria-label={RESULT_COPY.visualStyleLabel}
                  value={form.visualStyle}
                  onChange={(event) => setForm({ ...form, visualStyle: event.target.value })}
                  className="w-full rounded border border-zinc-300 px-3 py-2"
                >
                  {VISUAL_STYLES.map((style) => (
                    <option key={style.value} value={style.value}>
                      {style.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setForm(null);
                }}
                className="rounded border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                {RESULT_COPY.cancelAction}
              </button>
              <button
                type="button"
                data-testid="edit-save"
                onClick={saveEdit}
                disabled={busy || form.title.trim() === "" || form.body.trim() === ""}
                className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60"
              >
                {RESULT_COPY.saveAction}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleting ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-6">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={RESULT_COPY.deleteConfirmTitle}
            className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-xl"
          >
            <h2 className="text-lg font-semibold text-zinc-900">
              {RESULT_COPY.deleteConfirmTitle}
            </h2>
            <p className="text-sm leading-6 text-zinc-600">{RESULT_COPY.deleteConfirmBody}</p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                data-testid="delete-cancel"
                onClick={() => setDeleting(null)}
                className="rounded border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                {RESULT_COPY.cancelAction}
              </button>
              <button
                type="button"
                data-testid="delete-confirm"
                onClick={confirmDelete}
                disabled={busy}
                className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
              >
                {RESULT_COPY.confirmDelete}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {publishing ? (
        <PublishDialog
          result={publishing}
          shareEntry={shareEntry}
          onClose={() => setPublishing(null)}
          onPublished={(record: PublishRecordView) => {
            setJustPublished((current) => [...new Set([...current, record.resultId])]);
            setPublishing(null);
            setNotice(PUBLISH_COPY.markedNotice);
            // 服务端数据（结果标题、资源夹状态）跟着变；列表本身由 props 派生。
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
