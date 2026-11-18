import Link from "next/link";
import { notFound } from "next/navigation";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { STAGE_STATUS_TONE, TASK_STATUS_TONE } from "@/components/ui/status-tone";
import { isAppError } from "@/lib/errors";
import { STAGE_NAMES, TASK_COPY, type StageStatus } from "@/modules/generation/constants";
import { getTask } from "@/modules/generation/service";
import type { TaskDetailView } from "@/modules/generation/view";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

async function loadTask(id: string): Promise<TaskDetailView> {
  try {
    return await getTask(id);
  } catch (error) {
    // 不存在的任务走 404 页面，不把接口错误码暴露到界面上。
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}

function formatTime(value: string | null): string {
  return value ? value.slice(0, 16).replace("T", " ") : "—";
}

function ParameterRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 border-b border-zinc-100 py-2 last:border-b-0">
      <dt className="w-24 shrink-0 text-zinc-500">{label}</dt>
      <dd className="whitespace-pre-wrap break-words text-zinc-900">{value}</dd>
    </div>
  );
}

/** `/tasks/[id]`：任务详情（docs/prd/07「范围」）。执行次数、失败原因与配置快照都在这里。 */
export default async function TaskDetailPage({ params }: PageProps) {
  const { id } = await params;
  const task = await loadTask(id);

  return (
    <section className="space-y-6">
      <Link href="/tasks" className="text-sm text-zinc-500 hover:text-zinc-900">
        {TASK_COPY.backToList}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-zinc-900">{task.collectionName}</h1>
          <p className="flex flex-wrap items-center gap-3 text-sm text-zinc-500">
            <Pill tone={TASK_STATUS_TONE[task.status]}>{task.statusLabel}</Pill>
            <span>
              {TASK_COPY.createdAtLabel} {formatTime(task.createdAt)}
            </span>
          </p>
        </div>
        <Link
          href={`/collections/${task.collectionId}?tab=results`}
          className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100"
        >
          {TASK_COPY.viewResultAction}
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <h2 className="text-base font-semibold text-zinc-900">{TASK_COPY.stageSection}</h2>
          <ul className="space-y-3">
            {STAGE_NAMES.map((name) => {
              const stage = task.stages[name];
              return (
                <li key={name} data-testid={`stage-${name}-card`}>
                  <Panel bodyClassName="space-y-1 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-zinc-900">{stage.label}</span>
                      <span data-testid={`stage-${name}-status`}>
                        <Pill tone={STAGE_STATUS_TONE[stage.status as StageStatus]}>
                          {stage.statusLabel}
                        </Pill>
                      </span>
                    </div>
                    <p className="text-xs text-zinc-500">
                      {TASK_COPY.stageAttemptsLabel}{" "}
                      <span data-testid={`stage-${name}-attempts`}>{stage.attempts}</span> 次 ·{" "}
                      {TASK_COPY.stageFinishedLabel} {formatTime(stage.finishedAt)}
                    </p>
                    {stage.error ? (
                      <p data-testid={`stage-${name}-error`} className="text-xs text-red-600">
                        {TASK_COPY.stageErrorLabel}：{stage.error.message}
                      </p>
                    ) : null}
                  </Panel>
                </li>
              );
            })}
          </ul>
        </div>

        <Panel title={TASK_COPY.paramsLabel} className="h-fit">
          <dl className="text-sm">
            <ParameterRow label={TASK_COPY.visualStyleLabel} value={task.visualStyleLabel} />
            <ParameterRow label={TASK_COPY.copyStyleLabel} value={task.copyStyleLabel} />
            <ParameterRow label={TASK_COPY.imageCountLabel} value={`${task.imageCount} 张`} />
            <ParameterRow
              label={TASK_COPY.extraPromptLabel}
              value={task.extraPrompt ?? "未填写"}
            />
          </dl>
        </Panel>
      </div>

      <div className="space-y-3">
        <h2 className="text-base font-semibold text-zinc-900">{TASK_COPY.agentSection}</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {(["image", "copy"] as const).map((type) => (
            <Panel key={type}>
              <p className="font-medium text-zinc-900">
                {type === "image" ? "图片 Agent" : "文案 Agent"}
              </p>
              <p className="whitespace-pre-wrap break-words text-xs text-zinc-600">
                {task.agents[type].systemPrompt}
              </p>
            </Panel>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {task.result ? (
          <Link
            href={`/collections/${task.collectionId}?tab=results`}
            data-testid="result-entry"
            className="inline-block text-sm text-zinc-700 underline hover:text-zinc-900"
          >
            {/* 标题为空只说明文案阶段没成功，生图阶段的结果还在，不能说成「没有结果」。 */}
            {task.result.title ?? TASK_COPY.viewImagesAction}
          </Link>
        ) : (
          <p data-testid="no-result-hint" className="text-sm text-zinc-500">
            {TASK_COPY.noResult}
          </p>
        )}
      </div>
    </section>
  );
}
