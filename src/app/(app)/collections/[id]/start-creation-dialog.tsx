"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchJson } from "@/components/api";
import { COPY_STYLES } from "@/modules/copy-generation/styles";
import {
  CREATION_COPY,
  MAX_EXTRA_PROMPT_LENGTH,
  MAX_IMAGE_COUNT,
  MIN_IMAGE_COUNT,
} from "@/modules/generation/constants";
import { VISUAL_STYLES } from "@/modules/image-generation/styles";

/**
 * 「开始 AI 创作」：把任务参数交给 `POST /api/collections/[id]/tasks`，只写库就返回，
 * 两个阶段由 worker 推进。可选值来自各模块的登记表，界面不自己写死枚举（AGENTS.md 硬性规则 1）。
 */
interface StartCreationDialogProps {
  collectionId: string;
  /** 主按钮用于页头，次按钮用于结果页签的空状态。 */
  variant?: "primary" | "secondary";
  label?: string;
}

interface TaskEnvelope {
  task: { id: string };
}

export function StartCreationDialog({
  collectionId,
  variant = "primary",
  label = CREATION_COPY.action,
}: StartCreationDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [visualStyle, setVisualStyle] = useState<string>(VISUAL_STYLES[0].value);
  const [copyStyle, setCopyStyle] = useState<string>(COPY_STYLES[0].value);
  const [imageCount, setImageCount] = useState<number>(4);
  const [extraPrompt, setExtraPrompt] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await fetchJson<TaskEnvelope>(`/api/collections/${collectionId}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          visualStyle,
          copyStyle,
          imageCount,
          extraPrompt: extraPrompt.trim() === "" ? null : extraPrompt,
        }),
      });
      setOpen(false);
      // 任务已经进队列：直接去任务列表看两个阶段的状态。
      router.push("/tasks");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : CREATION_COPY.submitFailed);
      setSubmitting(false);
    }
  }

  const buttonClass =
    variant === "primary"
      ? "rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
      : "rounded border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100";

  return (
    <>
      <button type="button" data-testid="start-creation" onClick={() => setOpen(true)} className={buttonClass}>
        {label}
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-6">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={CREATION_COPY.title}
            className="w-full max-w-lg space-y-4 rounded-lg bg-white p-6 shadow-xl"
          >
            <div className="space-y-1">
              <h2 className="text-lg font-semibold text-zinc-900">{CREATION_COPY.title}</h2>
              <p className="text-sm text-zinc-600">{CREATION_COPY.intro}</p>
            </div>

            <div className="space-y-3 text-sm">
              <label className="block space-y-1">
                <span className="block font-medium text-zinc-900">
                  {CREATION_COPY.visualStyleLabel}
                </span>
                <select
                  aria-label={CREATION_COPY.visualStyleLabel}
                  value={visualStyle}
                  onChange={(event) => setVisualStyle(event.target.value)}
                  className="w-full rounded border border-zinc-300 px-3 py-2"
                >
                  {VISUAL_STYLES.map((style) => (
                    <option key={style.value} value={style.value}>
                      {style.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1">
                <span className="block font-medium text-zinc-900">
                  {CREATION_COPY.copyStyleLabel}
                </span>
                <select
                  aria-label={CREATION_COPY.copyStyleLabel}
                  value={copyStyle}
                  onChange={(event) => setCopyStyle(event.target.value)}
                  className="w-full rounded border border-zinc-300 px-3 py-2"
                >
                  {COPY_STYLES.map((style) => (
                    <option key={style.value} value={style.value}>
                      {style.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1">
                <span className="block font-medium text-zinc-900">
                  {CREATION_COPY.imageCountLabel}
                </span>
                <input
                  type="number"
                  aria-label={CREATION_COPY.imageCountLabel}
                  min={MIN_IMAGE_COUNT}
                  max={MAX_IMAGE_COUNT}
                  value={imageCount}
                  onChange={(event) => setImageCount(Number(event.target.value))}
                  className="w-32 rounded border border-zinc-300 px-3 py-2"
                />
              </label>

              <label className="block space-y-1">
                <span className="block font-medium text-zinc-900">
                  {CREATION_COPY.extraPromptLabel}
                </span>
                <textarea
                  aria-label={CREATION_COPY.extraPromptLabel}
                  maxLength={MAX_EXTRA_PROMPT_LENGTH}
                  rows={3}
                  value={extraPrompt}
                  onChange={(event) => setExtraPrompt(event.target.value)}
                  placeholder={CREATION_COPY.extraPromptPlaceholder}
                  className="w-full rounded border border-zinc-300 px-3 py-2"
                />
              </label>
            </div>

            {error ? (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            ) : null}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                {CREATION_COPY.cancelAction}
              </button>
              <button
                type="button"
                data-testid="submit-creation"
                onClick={submit}
                disabled={submitting}
                className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60"
              >
                {submitting ? "提交中…" : CREATION_COPY.submitAction}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
