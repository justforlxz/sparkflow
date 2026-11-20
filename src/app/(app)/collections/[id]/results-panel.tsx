"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchJson } from "@/components/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { useToast } from "@/components/ui/Toast";
import { buttonClass, noticeClass } from "@/components/ui/styles";
import { RESULT_COPY } from "@/modules/generation/constants";
import type { ResultView } from "@/modules/generation/view";
import { PUBLISH_COPY } from "@/modules/publish/constants";
import type { PublishRecordView } from "@/modules/publish/view";
import { EditResultDialog } from "./edit-result-dialog";
import { PublishDialog } from "./publish-dialog";

/**
 * 「AI 创作结果」页签（docs/prd/07「结果页签」）：
 * 1. 按创建时间倒序（服务端已排好）：图片网格可点开大图、标题、正文、标签、视觉风格、生成日期。
 * 2. `partial` 结果在文案区域给出「文案阶段失败」提示与重试入口，不留空白（AC-08-11）。
 * 3. 编辑结果原地更新，不改动原始素材与其它结果（AC-07-6）；编辑表单与创作区共用
 *    `EditResultDialog`（MKACG-916）。
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
  const toast = useToast();
  const [editing, setEditing] = useState<ResultView | null>(null);
  const [deleting, setDeleting] = useState<ResultView | null>(null);
  const [publishing, setPublishing] = useState<ResultView | null>(null);
  const [justPublished, setJustPublished] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const isPublished = (resultId: string): boolean =>
    publishedResultIds.includes(resultId) || justPublished.includes(resultId);

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
    try {
      // 只重试失败的文案阶段（ADR 0005）：生图阶段与已有图片都不动。
      await fetchJson(`/api/tasks/${result.taskId}/retry`, { method: "POST" });
      toast.show(RESULT_COPY.retryQueued, "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : RESULT_COPY.retryFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <ErrorState message={error} /> : null}

      <ul className="space-y-4">
        {results.map((result) => (
          <li key={result.id} data-testid="result-card" data-result-id={result.id}>
            <Panel bodyClassName="space-y-3">
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {result.assets.map((asset) => (
                  <li key={asset.id}>
                    <a
                      href={asset.url}
                      target="_blank"
                      rel="noreferrer"
                      title={RESULT_COPY.openLarge}
                      className="block rounded-md"
                    >
                      {/* 鉴权路由读取生成图片缩略图，不走 Next 图片优化器。 */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={asset.thumbnailUrl}
                        alt={asset.fileName}
                        className="h-32 w-full rounded-md border border-line object-cover transition-opacity hover:opacity-90"
                      />
                    </a>
                  </li>
                ))}
              </ul>

              {/* 生成图可能带模型自带的水印：让用户在交付前自己看见并确认（MKACG-901 MUST 1）。 */}
              <p
                data-testid="result-watermark-notice"
                className={noticeClass("warning", "text-footnote")}
              >
                {PUBLISH_COPY.upstreamWatermarkNotice}
              </p>

              <div className="space-y-2 text-body">
                {/* 失败提示只是附加说明：手动补写过的标题 / 正文 / 标签必须照常显示（docs/prd/07 MUST 1）。 */}
                {result.copyFailed ? (
                  <div className={noticeClass("warning", "space-y-2")}>
                    <p data-testid="copy-failed-hint">
                      {RESULT_COPY.copyFailedHint}
                    </p>
                    <button
                      type="button"
                      data-testid="copy-retry-button"
                      onClick={() => retryCopy(result)}
                      disabled={busy}
                      className={buttonClass({ variant: "warning", size: "sm" })}
                    >
                      {RESULT_COPY.retryAction}
                    </button>
                  </div>
                ) : null}

                {/* 视觉提取降级时必须标注原因与下一步动作，不得静默降级（docs/prd/06 AC-06-8）。 */}
                {result.copyVisualDegradedHint ? (
                  <p data-testid="copy-visual-degraded" className="text-footnote text-ink-tertiary">
                    {result.copyVisualDegradedHint}
                  </p>
                ) : null}

                {result.title ? (
                  <h3 data-testid="result-title" className="text-heading font-semibold text-ink">
                    {result.title}
                  </h3>
                ) : null}
                {result.body ? (
                  <p
                    data-testid="result-body"
                    className="whitespace-pre-wrap break-words text-ink-secondary"
                  >
                    {result.body}
                  </p>
                ) : null}
                {result.tags.length > 0 ? (
                  <p data-testid="result-tags" className="text-footnote text-ink-tertiary">
                    {result.tags.map((tag) => `#${tag}`).join(" ")}
                  </p>
                ) : null}

                <p className="text-footnote text-ink-tertiary">
                  {result.visualStyleLabel} · {RESULT_COPY.generatedAtLabel}{" "}
                  {result.createdAt.slice(0, 10)} · {RESULT_COPY.generatedImageCountLabel}{" "}
                  {result.assets.length} 张 ·{" "}
                  {/* 发布状态由服务端查到的记录决定，前端不推断（docs/prd/07 MUST NOT）。 */}
                  <Pill
                    data-testid="publish-status"
                    tone={isPublished(result.id) ? "published" : "neutral"}
                  >
                    {isPublished(result.id)
                      ? PUBLISH_COPY.statusPublished
                      : PUBLISH_COPY.statusUnpublished}
                  </Pill>
                </p>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="publish-prepare"
                    onClick={() => {
                      setPublishing(result);
                      setError(null);
                    }}
                    className={buttonClass({ variant: "primary", size: "sm" })}
                  >
                    {PUBLISH_COPY.prepareAction}
                  </button>
                  <button
                    type="button"
                    data-testid="edit-result"
                    onClick={() => {
                      setEditing(result);
                      setError(null);
                    }}
                    className={buttonClass({ variant: "secondary", size: "sm" })}
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
                    className={buttonClass({ variant: "danger", size: "sm" })}
                  >
                    {RESULT_COPY.deleteAction}
                  </button>
                </div>
              </div>
            </Panel>
          </li>
        ))}
      </ul>

      <EditResultDialog
        result={editing}
        onClose={() => setEditing(null)}
        onSaved={(updated) => {
          setPatched((current) => ({ ...current, [updated.id]: updated }));
          setEditing(null);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        danger
        title={RESULT_COPY.deleteConfirmTitle}
        body={RESULT_COPY.deleteConfirmBody}
        confirmLabel={RESULT_COPY.confirmDelete}
        cancelLabel={RESULT_COPY.cancelAction}
        busy={busy}
        confirmTestId="delete-confirm"
        cancelTestId="delete-cancel"
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />

      {publishing ? (
        <PublishDialog
          result={publishing}
          shareEntry={shareEntry}
          onClose={() => setPublishing(null)}
          onPublished={(record: PublishRecordView) => {
            setJustPublished((current) => [...new Set([...current, record.resultId])]);
            setPublishing(null);
            toast.show(PUBLISH_COPY.markedNotice, "success");
            // 服务端数据（结果标题、资源夹状态）跟着变；列表本身由 props 派生。
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
