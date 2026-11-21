"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "@/components/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { STAGE_STATUS_TONE, TASK_STATUS_TONE } from "@/components/ui/status-tone";
import { buttonClass, noticeClass } from "@/components/ui/styles";
import { useToast } from "@/components/ui/Toast";
import {
  CREATION_SECTION_COPY,
  RESULT_COPY,
  STAGE_POLL_INTERVAL_MS,
  TASK_COPY,
  type StageStatus,
} from "@/modules/generation/constants";
import {
  failedStages,
  groupCreationTasks,
  orderedStages,
  originalAssetLabel,
  readExpandedIds,
  toggleExpandedId,
  writeExpandedIds,
} from "@/modules/generation/creation";
import type { ResultView, TaskSummaryView } from "@/modules/generation/view";
import { PUBLISH_COPY } from "@/modules/publish/constants";
import type { PublishRecordView } from "@/modules/publish/view";
import { EditResultDialog } from "./edit-result-dialog";
import { PublishDialog } from "./publish-dialog";

/**
 * 资源夹详情的「AI 创作结果」页签（docs/prd/07-results.md）：
 *
 * 进度与结果都收在这一个组件里，原始素材页签只剩原图与来源信息（MKACG-933）。
 *
 * 1. 进行中的任务在最上面：两条阶段各自可见，生图阶段显示「正在生图 第 k/N 张」（MUST 1）。
 * 2. 失败 / 部分失败的任务紧随其后，带可读原因；只有真的失败阶段才给「重试」（MUST 2）。
 * 3. 结果默认折叠：一排提取图缩略图（按原图顺序）+ 一行摘要；点开才出现标题、正文、标签、
 *    「编辑」「整理发布」（MUST 3、MUST 4）。
 * 4. 折叠状态存本地，刷新后保持，不落库（MUST 5）。
 * 5. 既没有任务也没有结果时给「开始 AI 创作」引导，不留空白（MUST 6）。
 *
 * 图片一律走 `ImageLightbox`：缩略图是按钮，点开在站内弹窗看原图（「图片预览（全站统一）」）。
 * 任务数据先由服务端取一次，进入执行态后每 3 秒轮询 `GET /api/tasks`（MUST 4）；
 * 全部进入终态后停表，并让服务端重新渲染一次，好让新出现的结果进入折叠列表。
 */

interface CreationPanelProps {
  collectionId: string;
  /** 该资源夹的任务，服务端先取一次。 */
  initialTasks: TaskSummaryView[];
  /** 该资源夹的结果，按创建时间倒序（服务端已排好）。 */
  results: ResultView[];
  /** 已有发布记录的结果 id，由服务端查询后传入（不在前端推断，docs/prd/07 MUST NOT）。 */
  publishedResultIds: string[];
  /** 原图 id，按资源夹里的顺序：结果缩略图据此标出「对应第几张原图」（ADR 0008）。 */
  sourceAssetIds: string[];
  /** 功能开关渲染好的分享入口，转发给发布准备弹窗。 */
  shareEntry: React.ReactNode;
}

interface TaskListEnvelope {
  tasks: TaskSummaryView[];
}

interface TaskEnvelope {
  task: TaskSummaryView;
}

function formatTime(value: string): string {
  return value.slice(0, 16).replace("T", " ");
}

export function CreationPanel({
  collectionId,
  initialTasks,
  results,
  publishedResultIds,
  sourceAssetIds,
  shareEntry,
}: CreationPanelProps) {
  const router = useRouter();
  const toast = useToast();
  const [tasks, setTasks] = useState(initialTasks);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<ResultView | null>(null);
  const [deleting, setDeleting] = useState<ResultView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [publishing, setPublishing] = useState<ResultView | null>(null);
  /** 刚在这个页面上删掉 / 发布过的结果：界面立刻反映，不等服务端重新渲染。 */
  const [removedResultIds, setRemovedResultIds] = useState<string[]>([]);
  const [justPublished, setJustPublished] = useState<string[]>([]);
  /** 上一轮是否真的看到过执行中的任务：只有「跑完」才需要再让服务端渲染一次。 */
  const sawRunning = useRef(initialTasks.some((task) => task.status === "running"));

  /* 服务端重新渲染后（提交创作、重试完成、`router.refresh()`）把新数据接回来。
   * 在渲染过程中按「上次收到的服务端数据」对比调整，React 允许这种受控的写法，
   * 也避免多跑一轮副作用。 */
  const [serverTasks, setServerTasks] = useState(initialTasks);
  if (initialTasks !== serverTasks) {
    setServerTasks(initialTasks);
    setTasks(initialTasks);
  }

  /* 折叠状态只存在本浏览器（MUST 5）：必须等浏览器接管后再读，
   * 否则服务端渲染与首次客户端渲染不一致（水合报错）。 */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 一次性从浏览器本地存储读取折叠状态
    setExpandedIds(readExpandedIds(window.localStorage));
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const data = await fetchJson<TaskListEnvelope>("/api/tasks");
      const mine = data.tasks.filter((task) => task.collectionId === collectionId);
      const wasRunning = sawRunning.current;
      const nowRunning = mine.some((task) => task.status === "running");
      sawRunning.current = nowRunning;
      setTasks(mine);
      setError(null);
      // 刚跑完：让服务端把结果列表重新渲染出来，用户不用手动刷新。
      if (wasRunning && !nowRunning) router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : CREATION_SECTION_COPY.pollFailed);
    }
  }, [collectionId, router]);

  const polling = tasks.some((task) => task.status === "running");
  useEffect(() => {
    if (!polling) return;
    // 记下「确实看到过执行中」：跑到终态时才需要让服务端重新渲染一次结果列表。
    sawRunning.current = true;
    const timer = setInterval(() => void loadTasks(), STAGE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [polling, loadTasks]);

  function toggleExpanded(resultId: string) {
    const next = toggleExpandedId(expandedIds, resultId);
    setExpandedIds(next);
    writeExpandedIds(window.localStorage, next);
  }

  async function retryTask(task: TaskSummaryView) {
    setBusyId(task.id);
    setError(null);
    try {
      const data = await fetchJson<TaskEnvelope>(`/api/tasks/${task.id}/retry`, {
        method: "POST",
      });
      setTasks((current) => current.map((item) => (item.id === data.task.id ? data.task : item)));
      sawRunning.current = data.task.status === "running";
      toast.show(CREATION_SECTION_COPY.retryQueued, "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : TASK_COPY.retryFailed);
    } finally {
      setBusyId(null);
    }
  }

  async function retryCopy(result: ResultView) {
    setBusyId(result.id);
    setError(null);
    try {
      // 只重试失败的文案阶段（ADR 0005）：生图阶段与已有图片都不动。
      await fetchJson(`/api/tasks/${result.taskId}/retry`, { method: "POST" });
      toast.show(RESULT_COPY.retryQueued, "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : RESULT_COPY.retryFailed);
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    setError(null);
    try {
      await fetchJson<{ id: string }>(`/api/results/${deleting.id}`, { method: "DELETE" });
      setRemovedResultIds((current) => [...current, deleting.id]);
      setDeleting(null);
      // 资源夹头部的结果计数也要跟着变。
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : RESULT_COPY.deleteFailed);
    } finally {
      setDeleteBusy(false);
    }
  }

  const { running, troubled } = groupCreationTasks(tasks);
  const visibleResults = results.filter((result) => !removedResultIds.includes(result.id));
  const isPublished = (resultId: string) =>
    publishedResultIds.includes(resultId) || justPublished.includes(resultId);

  return (
    <section id="creation" aria-labelledby="creation-heading" className="min-w-0 space-y-3">
      <div className="space-y-1">
        <h2 id="creation-heading" className="text-heading font-semibold text-ink">
          {CREATION_SECTION_COPY.title}
        </h2>
        <p className="text-footnote text-ink-tertiary">{CREATION_SECTION_COPY.description}</p>
      </div>

      {error ? <ErrorState message={error} /> : null}

      {running.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-body font-medium text-ink">{CREATION_SECTION_COPY.runningTitle}</h3>
          <ul className="space-y-3">
            {running.map((task) => (
              <li key={task.id} data-testid="creation-running-task" data-task-id={task.id}>
                <Panel bodyClassName="space-y-2 text-body">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-footnote text-ink-tertiary">
                      {formatTime(task.createdAt)} · {task.extractRequirementLabel} · {task.copyStyleLabel}
                    </span>
                    <Pill tone={TASK_STATUS_TONE[task.status]}>{task.statusLabel}</Pill>
                  </div>
                  <dl className="flex flex-wrap gap-2 text-footnote">
                    {orderedStages(task).map((stage) => (
                      <div
                        key={stage.stage}
                        className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-line px-2 py-1"
                      >
                        <dt className="text-ink-tertiary">{stage.label}</dt>
                        <dd data-testid={`creation-stage-${stage.stage}-status`}>
                          <Pill tone={STAGE_STATUS_TONE[stage.status as StageStatus]}>
                            {stage.statusLabel}
                          </Pill>
                        </dd>
                        {/* 执行中显示进度：「正在生图 第 k/N 张」（生图阶段一对一出图）。 */}
                        {stage.progress ? (
                          <dd
                            data-testid={`creation-stage-${stage.stage}-progress`}
                            className="text-ink-tertiary"
                          >
                            {TASK_COPY.stageProgressLabel} 第 {stage.progress.done}/
                            {stage.progress.total} 张
                          </dd>
                        ) : null}
                      </div>
                    ))}
                  </dl>
                </Panel>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {troubled.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-body font-medium text-ink">{CREATION_SECTION_COPY.troubledTitle}</h3>
          <ul className="space-y-3">
            {troubled.map((task) => {
              const failed = failedStages(task);
              return (
                <li key={task.id} data-testid="creation-troubled-task" data-task-id={task.id}>
                  <Panel bodyClassName="space-y-2 text-body">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-footnote text-ink-tertiary">
                        {formatTime(task.createdAt)} · {task.extractRequirementLabel} ·{" "}
                        {task.copyStyleLabel}
                      </span>
                      <Pill tone={TASK_STATUS_TONE[task.status]}>{task.statusLabel}</Pill>
                    </div>

                    {/* 可读原因来自阶段已经脱敏、截断过的错误信息（docs/prd/04 MUST 5）。 */}
                    {orderedStages(task)
                      .filter((stage) => stage.error)
                      .map((stage) => (
                        <p
                          key={stage.stage}
                          data-testid={`creation-stage-${stage.stage}-error`}
                          className="break-words text-footnote text-danger"
                        >
                          {stage.label}：
                          {stage.status === "succeeded"
                            ? TASK_COPY.stagePartialErrorLabel
                            : TASK_COPY.stageErrorLabel}
                          ：{stage.error?.message}
                        </p>
                      ))}

                    {task.retryHint ? (
                      <p className="text-footnote text-ink-tertiary">{task.retryHint.message}</p>
                    ) : null}

                    {failed.length > 0 ? (
                      <button
                        type="button"
                        data-testid="creation-retry-button"
                        onClick={() => void retryTask(task)}
                        disabled={busyId === task.id}
                        className={buttonClass({ variant: "warning", size: "sm" })}
                      >
                        {TASK_COPY.retryAction}
                      </button>
                    ) : null}
                  </Panel>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {visibleResults.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-body font-medium text-ink">{CREATION_SECTION_COPY.resultsTitle}</h3>
          <ul className="space-y-3">
            {visibleResults.map((result) => {
              const panelId = `creation-result-${result.id}`;
              const expanded = expandedIds.includes(result.id);
              const published = isPublished(result.id);
              return (
                <li key={result.id} data-testid="result-card" data-result-id={result.id}>
                  <Panel bodyClassName="space-y-3">
                    {/* 折叠态：一排提取图缩略图，按原图顺序，标出对应第几张原图（MUST 3）。 */}
                    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                      {result.assets.map((asset) => (
                        <li key={asset.id} className="min-w-0 space-y-1">
                          <ImageLightbox
                            image={asset}
                            openLabel={RESULT_COPY.openLarge}
                            closeLabel={PUBLISH_COPY.closeAction}
                            thumbnailClassName="h-20 w-full rounded-md border border-line object-cover transition-opacity hover:opacity-90"
                          />
                          <span
                            data-testid="result-source"
                            className="block truncate text-caption text-ink-tertiary"
                          >
                            {originalAssetLabel(asset.sourceAssetId, sourceAssetIds)}
                          </span>
                        </li>
                      ))}
                    </ul>

                    <button
                      type="button"
                      data-testid="result-toggle"
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      onClick={() => toggleExpanded(result.id)}
                      className="flex w-full flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-panel px-3 py-2 text-left transition-colors hover:bg-soft"
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2 text-footnote text-ink-secondary">
                        <span>
                          {CREATION_SECTION_COPY.summaryGeneratedAt} {result.createdAt.slice(0, 10)}
                        </span>
                        <span aria-hidden="true">·</span>
                        {/* 本次的提取目标来自任务快照（ADR 0009）：老任务没有这一项时显示占位。 */}
                        <span data-testid="result-extract-target" className="min-w-0 truncate">
                          {CREATION_SECTION_COPY.extractTargetLabel}：
                          {result.extractTarget?.trim() ? result.extractTarget : "—"}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {RESULT_COPY.generatedImageCountLabel} {result.assets.length}{" "}
                          {CREATION_SECTION_COPY.summaryImageCountLabel}
                        </span>
                        <span aria-hidden="true">·</span>
                        {/* 发布状态由服务端查到的记录决定，前端不推断（docs/prd/07 MUST NOT）。 */}
                        <Pill
                          data-testid="publish-status"
                          tone={published ? "published" : "neutral"}
                        >
                          {published ? PUBLISH_COPY.statusPublished : PUBLISH_COPY.statusUnpublished}
                        </Pill>
                        {result.copyFailed ? (
                          <span className="text-warning">{CREATION_SECTION_COPY.copyFailedLabel}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-footnote font-medium text-accent-strong">
                        {expanded
                          ? CREATION_SECTION_COPY.collapseAction
                          : CREATION_SECTION_COPY.expandAction}
                      </span>
                    </button>

                    {/* 水印提示（docs/prd/05「水印提示文案（定稿）」）：折叠态一行用短文案，
                        展开后换成主文案；两段都引用 PUBLISH_COPY，不在这里另写一份。
                        提示是说明不是阻断：不加勾选、不阻止发布。 */}
                    {expanded ? (
                      <p
                        data-testid="result-watermark-notice"
                        className={noticeClass("warning", "text-footnote")}
                      >
                        {PUBLISH_COPY.upstreamWatermarkNotice}
                      </p>
                    ) : (
                      <p
                        data-testid="result-watermark-short-notice"
                        className={noticeClass("warning", "text-footnote")}
                      >
                        {PUBLISH_COPY.upstreamWatermarkShortNotice}
                      </p>
                    )}

                    {/* 展开后才出现文案与操作（MUST 4）。 */}
                    {expanded ? (
                      <div id={panelId} className="space-y-2 border-t border-line pt-3 text-body">
                        {/* 失败提示只是附加说明：手动补写过的标题 / 正文 / 标签必须照常显示。 */}
                        {result.copyFailed ? (
                          <div className={noticeClass("warning", "space-y-2")}>
                            <p data-testid="copy-failed-hint">{RESULT_COPY.copyFailedHint}</p>
                            <button
                              type="button"
                              data-testid="copy-retry-button"
                              onClick={() => void retryCopy(result)}
                              disabled={busyId === result.id}
                              className={buttonClass({ variant: "warning", size: "sm" })}
                            >
                              {RESULT_COPY.retryAction}
                            </button>
                          </div>
                        ) : null}

                        {/* 视觉提取降级时必须标注原因与下一步动作（docs/prd/06 AC-06-8）。 */}
                        {result.copyVisualDegradedHint ? (
                          <p data-testid="copy-visual-degraded" className="text-footnote text-ink-tertiary">
                            {result.copyVisualDegradedHint}
                          </p>
                        ) : null}

                        {result.title ? (
                          <h4 data-testid="result-title" className="text-body-lg font-semibold text-ink">
                            {result.title}
                          </h4>
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
                          <p data-testid="result-tags" className="break-words text-footnote text-ink-tertiary">
                            {result.tags.map((tag) => `#${tag}`).join(" ")}
                          </p>
                        ) : null}

                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            data-testid="edit-result"
                            onClick={() => setEditing(result)}
                            className={buttonClass({ variant: "secondary", size: "sm" })}
                          >
                            {RESULT_COPY.editAction}
                          </button>
                          <button
                            type="button"
                            data-testid="publish-prepare"
                            onClick={() => setPublishing(result)}
                            className={buttonClass({ variant: "primary", size: "sm" })}
                          >
                            {PUBLISH_COPY.prepareAction}
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
                    ) : null}
                  </Panel>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {tasks.length === 0 && visibleResults.length === 0 ? (
        <EmptyState
          message={CREATION_SECTION_COPY.emptyMessage}
          hint={CREATION_SECTION_COPY.emptyHint}
        />
      ) : null}

      <EditResultDialog
        result={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          // 结果标题等字段变了，服务端重新渲染一次就好，本地不另存一份。
          router.refresh();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        danger
        title={RESULT_COPY.deleteConfirmTitle}
        body={RESULT_COPY.deleteConfirmBody}
        confirmLabel={RESULT_COPY.confirmDelete}
        cancelLabel={RESULT_COPY.cancelAction}
        busy={deleteBusy}
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
            // 发布状态是服务端查出来的（docs/prd/07 MUST NOT），刷新一次让它进来。
            router.refresh();
          }}
        />
      ) : null}
    </section>
  );
}
