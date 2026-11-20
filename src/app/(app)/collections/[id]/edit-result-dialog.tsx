"use client";

import { useState } from "react";
import { fetchJson } from "@/components/api";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  buttonClass,
  dialogClass,
  DIALOG_TITLE_CLASS,
  FIELD_CLASS,
  HINT_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  OVERLAY_CLASS,
  SELECT_CLASS,
  TEXTAREA_CLASS,
} from "@/components/ui/styles";
import { useToast } from "@/components/ui/Toast";
import { RESULT_COPY } from "@/modules/generation/constants";
import type { ResultView } from "@/modules/generation/view";
import { describeResultStyle, EXTRACT_REQUIREMENTS } from "@/modules/image-generation/styles";
import { parseTagInput } from "@/modules/publish/text";

/**
 * 编辑结果弹窗（docs/prd/07 MUST 3）：改标题 / 正文 / 标签 / 视觉风格，保存后原地更新。
 *
 * 单独成文件的原因：结果页签与资源夹详情的「创作」区都要能编辑结果（MKACG-916 MUST 3），
 * 两处各写一份表单迟早会走样。请求、校验与提示都在这里，调用方只拿到保存后的结果。
 */
export interface EditResultDialogProps {
  /** 要编辑的结果；`null` 表示没打开，此时不渲染。 */
  result: ResultView | null;
  onClose: () => void;
  /** 保存成功：调用方据此原地替换列表里的这条结果（AC-07-6）。 */
  onSaved: (result: ResultView) => void;
}

interface EditForm {
  title: string;
  body: string;
  tags: string;
  visualStyle: string;
}

interface ResultEnvelope {
  result: ResultView;
}

/** 标签输入框的解析与格式化在发布模块里（`publish/text.ts`）：发布准备弹窗用同一套规则。 */
function toForm(result: ResultView): EditForm {
  return {
    title: result.title ?? "",
    body: result.body ?? "",
    tags: result.tags.join("，"),
    visualStyle: result.visualStyle,
  };
}

export function EditResultDialog({ result, onClose, onSaved }: EditResultDialogProps) {
  // 外层不持有表单状态：换一条结果时由 `key` 重置，不会残留上一条的输入。
  if (!result) return null;
  return <EditResultForm key={result.id} result={result} onClose={onClose} onSaved={onSaved} />;
}

function EditResultForm({
  result,
  onClose,
  onSaved,
}: {
  result: ResultView;
  onClose: () => void;
  onSaved: (result: ResultView) => void;
}) {
  const [form, setForm] = useState<EditForm>(() => toForm(result));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const data = await fetchJson<ResultEnvelope>(`/api/results/${result.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: form.title.trim(),
          body: form.body.trim(),
          tags: parseTagInput(form.tags),
          visualStyle: form.visualStyle,
        }),
      });
      toast.show(RESULT_COPY.saveSucceeded, "success");
      onSaved(data.result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : RESULT_COPY.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={OVERLAY_CLASS}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={RESULT_COPY.editTitle}
        className={dialogClass({ width: "lg" })}
      >
        <h2 className={DIALOG_TITLE_CLASS}>{RESULT_COPY.editTitle}</h2>

        {error ? <ErrorState message={error} /> : null}

        <div className="space-y-3 text-body">
          <label className={FIELD_CLASS}>
            <span className={LABEL_CLASS}>{RESULT_COPY.titleLabel}</span>
            <input
              aria-label={RESULT_COPY.titleLabel}
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              className={INPUT_CLASS}
            />
          </label>
          <label className={FIELD_CLASS}>
            <span className={LABEL_CLASS}>{RESULT_COPY.bodyLabel}</span>
            <textarea
              aria-label={RESULT_COPY.bodyLabel}
              rows={6}
              value={form.body}
              onChange={(event) => setForm({ ...form, body: event.target.value })}
              className={TEXTAREA_CLASS}
            />
          </label>
          <label className={FIELD_CLASS}>
            <span className={LABEL_CLASS}>{RESULT_COPY.tagsLabel}</span>
            <input
              aria-label={RESULT_COPY.tagsLabel}
              value={form.tags}
              onChange={(event) => setForm({ ...form, tags: event.target.value })}
              className={INPUT_CLASS}
            />
            <span className={HINT_CLASS}>{RESULT_COPY.tagsHint}</span>
          </label>
          <label className={FIELD_CLASS}>
            <span className={LABEL_CLASS}>{RESULT_COPY.visualStyleLabel}</span>
            <select
              aria-label={RESULT_COPY.visualStyleLabel}
              value={form.visualStyle}
              onChange={(event) => setForm({ ...form, visualStyle: event.target.value })}
              className={SELECT_CLASS}
            >
              {/* 历史结果存的是旧视觉方向 key（ADR 0009 不做数据迁移）：先补一个当前值的选项，
                  避免打开编辑就把它的视觉风格悄悄改成新选项。 */}
              {EXTRACT_REQUIREMENTS.some((entry) => entry.value === form.visualStyle) ? null : (
                <option value={form.visualStyle}>{describeResultStyle(form.visualStyle)}</option>
              )}
              {EXTRACT_REQUIREMENTS.map((requirement) => (
                <option key={requirement.value} value={requirement.value}>
                  {requirement.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className={buttonClass({ variant: "secondary" })}>
            {RESULT_COPY.cancelAction}
          </button>
          <button
            type="button"
            data-testid="edit-save"
            onClick={save}
            disabled={busy || form.title.trim() === "" || form.body.trim() === ""}
            className={buttonClass({ variant: "primary" })}
          >
            {RESULT_COPY.saveAction}
          </button>
        </div>
      </div>
    </div>
  );
}
