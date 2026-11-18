"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchJson } from "@/components/api";
import { STAGE_NAMES, TASK_COPY } from "@/modules/generation/constants";
import type { TaskSummaryView } from "@/modules/generation/view";

/**
 * 任务列表（docs/prd/07「任务列表」）：
 * 1. 两条阶段各自一个标签，不合并成一个总状态（MUST 1）。
 * 2. 失败阶段旁出现「重试」，只重试失败阶段（MUST 2、ADR 0005）。
 * 3. 「重新生成」先确认再新建任务，取消不产生请求（MUST 3）。
 * 4. `queued`/`running` 时每 3 秒轮询一次，终态停止，离开页面清理定时器（MUST 4、AC-07-9）。
 */

/** 轮询间隔（docs/prd/07 MUST 4）。 */
const POLL_INTERVAL_MS = 3000;

interface TaskListProps {
  initialTasks: TaskSummaryView[];
}

interface TaskEnvelope {
  task: TaskSummaryView;
}

interface TaskListEnvelope {
  tasks: TaskSummaryView[];
}

function formatTime(value: string): string {
  return value.slice(0, 16).replace("T", " ");
}

/** 任务处于终态就不再轮询：派生状态只有 `running` 时阶段还在排队或执行。 */
function needsPolling(tasks: readonly TaskSummaryView[]): boolean {
  return tasks.some((task) => task.status === "running");
}

function failedStageNames(task: TaskSummaryView): string[] {
  return STAGE_NAMES.filter((name) => task.stages[name].status === "failed").map(
    (name) => task.stages[name].label,
  );
}

export function TaskList({ initialTasks }: TaskListProps) {
  const [tasks, setTasks] = useState(initialTasks);
  const [error, setError] = useState<string | null>(null);
  /** 正在重试 / 重新生成的任务 id，用来禁用按钮，避免重复提交。 */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<TaskSummaryView | null>(null);
  const polling = needsPolling(tasks);

  useEffect(() => {
    if (!polling) return;

    let stopped = false;
    const timer = setInterval(() => {
      fetchJson<TaskListEnvelope>("/api/tasks")
        .then((data) => {
          if (stopped) return;
          setTasks(data.tasks);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (stopped) return;
          setError(cause instanceof Error ? cause.message : TASK_COPY.refreshFailed);
        });
    }, POLL_INTERVAL_MS);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [polling]);

  function replaceTask(task: TaskSummaryView) {
    setTasks((current) => current.map((item) => (item.id === task.id ? task : item)));
  }

  async function retry(task: TaskSummaryView) {
    setBusyId(task.id);
    setError(null);
    try {
      const data = await fetchJson<TaskEnvelope>(`/api/tasks/${task.id}/retry`, { method: "POST" });
      replaceTask(data.task);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : TASK_COPY.retryFailed);
    } finally {
      setBusyId(null);
    }
  }

  async function regenerate(task: TaskSummaryView) {
    setBusyId(task.id);
    setError(null);
    try {
      const data = await fetchJson<TaskEnvelope>(`/api/collections/${task.collectionId}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          visualStyle: task.visualStyle,
          copyStyle: task.copyStyle,
          imageCount: task.imageCount,
          extraPrompt: task.extraPrompt,
        }),
      });
      setTasks((current) => [data.task, ...current]);
      setConfirming(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : TASK_COPY.regenerateFailed);
    } finally {
      setBusyId(null);
    }
  }

  if (tasks.length === 0) {
    return (
      <div className="space-y-3 rounded border border-dashed border-zinc-300 bg-white px-6 py-10 text-center">
        <p className="text-sm text-zinc-600">{TASK_COPY.emptyList}</p>
        <Link
          href="/collections"
          className="inline-block rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          {TASK_COPY.listAction}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <ul className="space-y-3">
        {tasks.map((task) => {
          const failed = failedStageNames(task);
          return (
            <li
              key={task.id}
              data-testid="task-row"
              data-task-id={task.id}
              data-task-status={task.status}
              className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 text-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <Link
                    href={`/collections/${task.collectionId}`}
                    className="font-medium text-zinc-900 hover:underline"
                  >
                    {task.collectionName}
                  </Link>
                  <p className="text-xs text-zinc-500">
                    {formatTime(task.createdAt)} · {task.visualStyleLabel} · {task.copyStyleLabel} ·{" "}
                    {TASK_COPY.imageCountLabel} {task.imageCount} 张
                  </p>
                </div>
                <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                  {task.statusLabel}
                </span>
              </div>

              <dl className="flex flex-wrap gap-2 text-xs">
                {STAGE_NAMES.map((name) => {
                  const stage = task.stages[name];
                  return (
                    <div
                      key={name}
                      className="flex items-center gap-2 rounded border border-zinc-200 px-2 py-1"
                    >
                      <dt className="text-zinc-500">{stage.label}</dt>
                      <dd
                        data-testid={`stage-${name}-status`}
                        className={stage.status === "failed" ? "text-red-600" : "text-zinc-900"}
                      >
                        {stage.statusLabel}
                      </dd>
                      <span className="text-zinc-400">第 {stage.attempts} 次</span>
                    </div>
                  );
                })}
              </dl>

              {failed.length > 0 ? (
                <div className="space-y-1 text-xs text-red-600">
                  {STAGE_NAMES.filter((name) => task.stages[name].error).map((name) => (
                    <p key={name} data-testid={`stage-${name}-error`}>
                      {task.stages[name].label}：{task.stages[name].error?.message}
                    </p>
                  ))}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/collections/${task.collectionId}?tab=results`}
                  className="rounded border border-zinc-300 px-3 py-1.5 text-zinc-700 hover:bg-zinc-100"
                >
                  {TASK_COPY.viewResultAction}
                </Link>
                <Link
                  href={`/tasks/${task.id}`}
                  className="rounded border border-zinc-300 px-3 py-1.5 text-zinc-700 hover:bg-zinc-100"
                >
                  {TASK_COPY.detailAction}
                </Link>
                {failed.length > 0 ? (
                  <button
                    type="button"
                    data-testid="retry-button"
                    onClick={() => retry(task)}
                    disabled={busyId === task.id}
                    className="rounded bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700 disabled:opacity-60"
                  >
                    {TASK_COPY.retryAction}
                  </button>
                ) : null}
                <button
                  type="button"
                  data-testid="regenerate-button"
                  onClick={() => setConfirming(task)}
                  disabled={busyId === task.id}
                  className="rounded border border-zinc-300 px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-60"
                >
                  {TASK_COPY.regenerateAction}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {confirming ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-6">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={TASK_COPY.regenerateConfirmTitle}
            className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-xl"
          >
            <h2 className="text-lg font-semibold text-zinc-900">
              {TASK_COPY.regenerateConfirmTitle}
            </h2>
            <p className="text-sm leading-6 text-zinc-600">{TASK_COPY.regenerateConfirmBody}</p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                data-testid="regenerate-cancel"
                onClick={() => setConfirming(null)}
                className="rounded border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                {TASK_COPY.cancelAction}
              </button>
              <button
                type="button"
                data-testid="regenerate-confirm"
                onClick={() => regenerate(confirming)}
                disabled={busyId === confirming.id}
                className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60"
              >
                {TASK_COPY.confirmAction}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
