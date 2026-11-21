"use client";

import { ErrorState } from "@/components/ui/ErrorState";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { fetchJson } from "@/components/api";
import {
  buttonClass,
  dialogClass,
  DIALOG_TITLE_CLASS,
  FIELD_CLASS,
  LABEL_CLASS,
  OVERLAY_CLASS,
  SELECT_CLASS,
  TEXTAREA_CLASS,
} from "@/components/ui/styles";
import { COPY_STYLES } from "@/modules/copy-generation/styles";
import { CREATION_COPY, MAX_EXTRA_PROMPT_LENGTH } from "@/modules/generation/constants";
import { EXTRACT_REQUIREMENTS } from "@/modules/image-generation/styles";

/**
 * 「开始 AI 创作」：把任务参数交给 `POST /api/collections/[id]/tasks`，只写库就返回，
 * 两个阶段由 worker 推进。可选值来自各模块的登记表，界面不自己写死枚举（AGENTS.md 硬性规则 1）。
 *
 * 两件事同时成立：
 * 1. 资源夹允许没有图片，但发起创作要求至少一张原图（docs/prd/01 MUST 1、docs/prd/04）。
 *    0 张时按钮置灰成不可用状态，点击只提示「先上传原始素材」，不发请求（AC-01-2）。
 * 2. 张数不再由用户选择：一张原图出一张素材图（ADR 0008），弹窗只显示「预计提取图张数」。
 * 3. 提取目标在资源夹上维护，这里只读显示（ADR 0009）：空的时候发起创作会被拒绝。
 */
interface StartCreationDialogProps {
  collectionId: string;
  /** 资源夹当前的原图张数：决定按钮是否可用，也是预计提取图张数（ADR 0008）。 */
  assetCount: number;
  /** 资源夹的提取目标：只读显示，发起创作时必填（ADR 0009）。 */
  extractTarget: string | null;
  /** 主按钮用于页头，次按钮用于结果页签的空状态。 */
  variant?: "primary" | "secondary";
  label?: string;
}

interface TaskEnvelope {
  task: { id: string };
}

export function StartCreationDialog({
  collectionId,
  assetCount,
  extractTarget,
  variant = "primary",
  label = CREATION_COPY.action,
}: StartCreationDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [extractRequirement, setExtractRequirement] = useState<string>(
    EXTRACT_REQUIREMENTS[0].value,
  );
  const [copyStyle, setCopyStyle] = useState<string>(COPY_STYLES[0].value);
  const [extraPrompt, setExtraPrompt] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 没有原始素材就不让进创作弹窗：任务创建接口会拒绝，界面上先挡住并说明原因。
  const blocked = assetCount < 1;

  function openDialog() {
    if (blocked) {
      setHint(CREATION_COPY.needsImages);
      return;
    }
    setHint(null);
    setOpen(true);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await fetchJson<TaskEnvelope>(`/api/collections/${collectionId}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          extractRequirement,
          copyStyle,
          extraPrompt: extraPrompt.trim() === "" ? null : extraPrompt,
        }),
      });
      setOpen(false);
      /* 不跳 `/tasks`（MKACG-916 MUST 1、AC-C-1）：回到资源夹详情的「AI 创作结果」页签，
       * 那里就地显示两个阶段的状态、「第 k/N 张」进度与随后出现的结果（MKACG-933）。
       * 显式带上 `?tab=results`：进度与结果都在这个页签；
       * 而且查询串变化才会重新取服务端数据（同一路径只改 hash 不会刷新）。 */
      router.push(`/collections/${collectionId}?tab=results#creation`);
      /* 任务已经落库，但「AI 创作结果」页签的链接在进入页面时就被预取过：
       * 直接用它渲染会拿到「还没有任务」的旧数据。刷新一次让服务端重新取。 */
      router.refresh();
      setSubmitting(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : CREATION_COPY.submitFailed);
      setSubmitting(false);
    }
  }

  const triggerClass = buttonClass({ variant: variant === "primary" ? "primary" : "secondary" });
  // 置灰的样式来自通用按钮类的 `aria-disabled:` 变体，这里只负责状态与提示语。

  return (
    <>
      <div className="space-y-1">
        <button
          type="button"
          data-testid="start-creation"
          aria-disabled={blocked || undefined}
          onClick={openDialog}
          className={triggerClass}
        >
          {label}
        </button>
        {hint ? (
          <p role="status" className="text-footnote text-warning">
            {hint}
          </p>
        ) : null}
      </div>

      {open ? (
        <div className={OVERLAY_CLASS}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={CREATION_COPY.title}
            className={dialogClass({ width: "lg" })}
          >
            <div className="space-y-1">
              <h2 className={DIALOG_TITLE_CLASS}>{CREATION_COPY.title}</h2>
              <p className="text-body text-ink-secondary">{CREATION_COPY.intro}</p>
            </div>

            <div className="space-y-3 text-body">
              {/* 提取目标在资源夹上维护（ADR 0009）：这里只读显示，用户知道这次会取什么。 */}
              <div className={`${FIELD_CLASS} rounded-md border border-line px-3 py-2`}>
                <span className={LABEL_CLASS}>{CREATION_COPY.extractTargetLabel}</span>
                <p data-testid="creation-extract-target" className="whitespace-pre-wrap break-words text-body text-ink">
                  {extractTarget?.trim() ? extractTarget : "未填写"}
                </p>
              </div>

              <label className={FIELD_CLASS}>
                <span className={LABEL_CLASS}>{CREATION_COPY.extractRequirementLabel}</span>
                <select
                  aria-label={CREATION_COPY.extractRequirementLabel}
                  value={extractRequirement}
                  onChange={(event) => setExtractRequirement(event.target.value)}
                  className={SELECT_CLASS}
                >
                  {EXTRACT_REQUIREMENTS.map((requirement) => (
                    <option key={requirement.value} value={requirement.value}>
                      {requirement.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className={FIELD_CLASS}>
                <span className={LABEL_CLASS}>{CREATION_COPY.copyStyleLabel}</span>
                <select
                  aria-label={CREATION_COPY.copyStyleLabel}
                  value={copyStyle}
                  onChange={(event) => setCopyStyle(event.target.value)}
                  className={SELECT_CLASS}
                >
                  {COPY_STYLES.map((style) => (
                    <option key={style.value} value={style.value}>
                      {style.label}
                    </option>
                  ))}
                </select>
              </label>

              {/* 张数不再可选：提取图张数 = 原图张数（ADR 0008），这里只告诉用户会出几张。 */}
              <div className={`${FIELD_CLASS} rounded-md border border-line px-3 py-2`}>
                <span className={LABEL_CLASS}>{CREATION_COPY.expectedImageCountLabel}</span>
                <p data-testid="expected-image-count" className="text-body text-ink">
                  {assetCount} 张
                </p>
                <p className="text-footnote text-ink-tertiary">
                  {CREATION_COPY.expectedImageCountHint}
                </p>
              </div>

              <label className={FIELD_CLASS}>
                <span className={LABEL_CLASS}>{CREATION_COPY.extraPromptLabel}</span>
                <textarea
                  aria-label={CREATION_COPY.extraPromptLabel}
                  maxLength={MAX_EXTRA_PROMPT_LENGTH}
                  rows={3}
                  value={extraPrompt}
                  onChange={(event) => setExtraPrompt(event.target.value)}
                  placeholder={CREATION_COPY.extraPromptPlaceholder}
                  className={TEXTAREA_CLASS}
                />
              </label>
            </div>

            {error ? <ErrorState message={error} /> : null}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className={buttonClass({ variant: "secondary" })}
              >
                {CREATION_COPY.cancelAction}
              </button>
              <button
                type="button"
                data-testid="submit-creation"
                onClick={submit}
                disabled={submitting}
                className={buttonClass({ variant: "primary" })}
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
