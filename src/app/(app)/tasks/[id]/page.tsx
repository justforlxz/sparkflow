import Link from "next/link";
import { notFound } from "next/navigation";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { STAGE_STATUS_TONE, TASK_STATUS_TONE } from "@/components/ui/status-tone";
import {
  buttonClass,
  noticeClass,
  PAGE_SUBTITLE_CLASS,
  PAGE_TITLE_CLASS,
  TEXT_LINK_CLASS,
} from "@/components/ui/styles";
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
    <div className="flex gap-3 border-b border-line py-2 last:border-b-0">
      <dt className="w-24 shrink-0 text-ink-tertiary">{label}</dt>
      <dd className="whitespace-pre-wrap break-words text-ink">{value}</dd>
    </div>
  );
}

/** `/tasks/[id]`：任务详情（docs/prd/07「范围」）。执行次数、失败原因与配置快照都在这里。 */
export default async function TaskDetailPage({ params }: PageProps) {
  const { id } = await params;
  const task = await loadTask(id);

  return (
    <section className="space-y-6">
      <Link href="/tasks" className={`text-footnote ${TEXT_LINK_CLASS}`}>
        {TASK_COPY.backToList}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className={PAGE_TITLE_CLASS}>{task.collectionName}</h1>
          <p className={`flex flex-wrap items-center gap-3 ${PAGE_SUBTITLE_CLASS}`}>
            <Pill tone={TASK_STATUS_TONE[task.status]}>{task.statusLabel}</Pill>
            <span>
              {TASK_COPY.createdAtLabel} {formatTime(task.createdAt)}
            </span>
          </p>
        </div>
        <Link
          href={`/collections/${task.collectionId}#creation`}
          className={buttonClass({ variant: "secondary" })}
        >
          {TASK_COPY.viewResultAction}
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <h2 className="text-heading font-semibold text-ink">{TASK_COPY.stageSection}</h2>
          <ul className="space-y-3">
            {STAGE_NAMES.map((name) => {
              const stage = task.stages[name];
              return (
                <li key={name} data-testid={`stage-${name}-card`}>
                  <Panel bodyClassName="space-y-1 text-body">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-ink">{stage.label}</span>
                      <span data-testid={`stage-${name}-status`}>
                        <Pill tone={STAGE_STATUS_TONE[stage.status as StageStatus]}>
                          {stage.statusLabel}
                        </Pill>
                      </span>
                    </div>
                    <p className="text-footnote text-ink-tertiary">
                      {TASK_COPY.stageAttemptsLabel}{" "}
                      <span data-testid={`stage-${name}-attempts`}>{stage.attempts}</span> 次 ·{" "}
                      {TASK_COPY.stageFinishedLabel} {formatTime(stage.finishedAt)}
                    </p>
                    {/* 执行中显示进度：「正在生图 第 k/N 张」（生图阶段一对一出图，耗时随素材量增长）。 */}
                    {stage.progress ? (
                      <p data-testid={`stage-${name}-progress`} className="text-footnote text-ink-tertiary">
                        {TASK_COPY.stageProgressLabel} 第 {stage.progress.done}/{stage.progress.total} 张
                      </p>
                    ) : null}
                    {stage.error ? (
                      <p data-testid={`stage-${name}-error`} className="text-footnote text-danger">
                        {/* 阶段已成功但有原图失败时，说「部分原图失败」而不是「失败原因」。 */}
                        {stage.status === "succeeded"
                          ? TASK_COPY.stagePartialErrorLabel
                          : TASK_COPY.stageErrorLabel}
                        ：{stage.error.message}
                      </p>
                    ) : null}
                  </Panel>
                </li>
              );
            })}
          </ul>
          {task.retryHint ? (
            <p
              data-testid="retry-hint"
              className={
                task.retryHint.state === "snapshot-changed"
                  ? noticeClass("warning", "text-footnote")
                  : "text-footnote text-ink-tertiary"
              }
            >
              {task.retryHint.message}
            </p>
          ) : null}
        </div>

        <Panel title={TASK_COPY.paramsLabel} className="h-fit">
          <dl className="text-body">
            <ParameterRow label={TASK_COPY.visualStyleLabel} value={task.visualStyleLabel} />
            <ParameterRow label={TASK_COPY.copyStyleLabel} value={task.copyStyleLabel} />
            <ParameterRow
              label={TASK_COPY.expectedImageCountLabel}
              value={`${task.expectedImageCount} 张`}
            />
            <ParameterRow
              label={TASK_COPY.extraPromptLabel}
              value={task.extraPrompt ?? "未填写"}
            />
          </dl>
        </Panel>
      </div>

      <div className="space-y-3">
        <h2 className="text-heading font-semibold text-ink">{TASK_COPY.agentSection}</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {(["image", "copy"] as const).map((type) => (
            <Panel key={type}>
              <p className="font-medium text-ink">
                {type === "image" ? "图片 Agent" : "文案 Agent"}
              </p>
              <p className="whitespace-pre-wrap break-words text-footnote text-ink-secondary">
                {task.agents[type].systemPrompt}
              </p>
            </Panel>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {task.result ? (
          <Link
            href={`/collections/${task.collectionId}#creation`}
            data-testid="result-entry"
            className={TEXT_LINK_CLASS}
          >
            {/* 标题为空只说明文案阶段没成功，生图阶段的结果还在，不能说成「没有结果」。 */}
            {task.result.title ?? TASK_COPY.viewImagesAction}
          </Link>
        ) : (
          <p data-testid="no-result-hint" className="text-body text-ink-tertiary">
            {TASK_COPY.noResult}
          </p>
        )}
        {/* 视觉提取降级时，任务详情也要标注（docs/prd/06 AC-06-8「任务详情与结果上标注」）。 */}
        {task.result?.copyVisualDegradedHint ? (
          <p data-testid="copy-visual-degraded" className="text-footnote text-ink-tertiary">
            {task.result.copyVisualDegradedHint}
          </p>
        ) : null}
      </div>
    </section>
  );
}
