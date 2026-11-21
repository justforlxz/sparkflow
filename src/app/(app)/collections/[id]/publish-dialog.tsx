"use client";

import { useState } from "react";
import { ErrorState } from "@/components/ui/ErrorState";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { fetchJson } from "@/components/api";
import {
  buttonClass,
  CHECKBOX_CLASS,
  dialogClass,
  DIALOG_TITLE_CLASS,
  FIELD_CLASS,
  HINT_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  noticeClass,
  OVERLAY_CLASS,
  TEXTAREA_CLASS,
} from "@/components/ui/styles";
import { RESULT_COPY } from "@/modules/generation/constants";
import type { ResultView } from "@/modules/generation/view";
import { PUBLISH_COPY } from "@/modules/publish/constants";
import { formatPublishText, parseTagInput } from "@/modules/publish/text";
import type { PublishRecordView } from "@/modules/publish/view";

/**
 * 发布准备弹窗（docs/prd/08「发布准备」）。
 *
 * 1. 图片默认全选，可单张取消；下载按当前勾选，1 张直下、多张 ZIP。
 * 2. 三个文案字段在这里编辑，标记已发布时一起写回结果并留下快照。
 * 3. 「复制文案」写入固定格式文本，剪贴板被拒时给出可读提示。
 * 4. 「分享到小红书」由页面用 `<FeatureGate>` 渲染后作为 `shareEntry` 传进来：
 *    功能关闭时它是不可操作的占位按钮，点击只提示文案，不发请求（AC-08-7、AC-10-5）。
 */

interface PublishDialogProps {
  result: ResultView;
  shareEntry: React.ReactNode;
  onClose: () => void;
  onPublished: (record: PublishRecordView) => void;
}

interface PublishEnvelope {
  record: PublishRecordView;
}

export function PublishDialog({ result, shareEntry, onClose, onPublished }: PublishDialogProps) {
  const [title, setTitle] = useState(result.title ?? "");
  const [body, setBody] = useState(result.body ?? "");
  const [tags, setTags] = useState(result.tags.join("，"));
  // MUST 1：默认全选。
  const [selected, setSelected] = useState<string[]>(() => result.assets.map((asset) => asset.id));
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggleAsset(assetId: string) {
    setSelected((current) =>
      current.includes(assetId)
        ? current.filter((candidate) => candidate !== assetId)
        : [...current, assetId],
    );
  }

  async function copyText() {
    setError(null);
    setNotice(null);
    const text = formatPublishText({ title, body, tags: parseTagInput(tags) });
    try {
      await navigator.clipboard.writeText(text);
      setNotice(PUBLISH_COPY.copiedNotice);
    } catch {
      // 浏览器拒绝剪贴板权限时不能静默失败（MUST 4）。
      setError(PUBLISH_COPY.copyFailed);
    }
  }

  async function markPublished() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = await fetchJson<PublishEnvelope>(`/api/results/${result.id}/publish`, {
        method: "POST",
        body: JSON.stringify({
          title,
          body,
          tags: parseTagInput(tags),
          selectedAssetIds: selected,
        }),
      });
      onPublished(data.record);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : PUBLISH_COPY.markFailed);
    } finally {
      setBusy(false);
    }
  }

  // 下载按勾选顺序拼地址：ZIP 里的序号就是这个顺序（AC-09-10）。
  const downloadHref =
    selected.length > 0
      ? `/api/results/${result.id}/download?assets=${selected.join(",")}`
      : null;

  return (
    <div className={OVERLAY_CLASS}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={PUBLISH_COPY.prepareTitle}
        className={dialogClass({ width: "2xl" })}
      >
        <div className="space-y-1">
          <h2 className={DIALOG_TITLE_CLASS}>{PUBLISH_COPY.prepareTitle}</h2>
          <p className="text-footnote text-ink-tertiary">{PUBLISH_COPY.prepareIntro}</p>
        </div>

        {error ? <ErrorState message={error} /> : null}
        {notice ? (
          <p role="status" className={noticeClass("positive")}>
            {notice}
          </p>
        ) : null}

        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-body-lg font-semibold text-ink">{PUBLISH_COPY.selectImagesLabel}</h3>
            <div className="flex gap-2 text-footnote">
              <button
                type="button"
                data-testid="publish-select-all"
                onClick={() => setSelected(result.assets.map((asset) => asset.id))}
                className={buttonClass({ variant: "secondary", size: "sm" })}
              >
                {PUBLISH_COPY.selectAllAction}
              </button>
              <button
                type="button"
                data-testid="publish-select-none"
                onClick={() => setSelected([])}
                className={buttonClass({ variant: "secondary", size: "sm" })}
              >
                {PUBLISH_COPY.selectNoneAction}
              </button>
            </div>
          </div>

          {/* 与结果页签同一处提示：发布前让用户自己确认水印（MKACG-901 MUST 1）。 */}
          <p
            data-testid="publish-watermark-notice"
            className={noticeClass("warning", "text-footnote")}
          >
            {PUBLISH_COPY.upstreamWatermarkNotice}
          </p>

          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {result.assets.map((asset) => (
              <li key={asset.id} className="space-y-1">
                {/* 缩略图点开在站内弹窗看原图；勾选只管下载与发布范围，两者分开（docs/prd/07）。 */}
                <ImageLightbox
                  image={asset}
                  openLabel={RESULT_COPY.openLarge}
                  closeLabel={PUBLISH_COPY.closeAction}
                  thumbnailClassName={
                    selected.includes(asset.id)
                      ? "h-24 w-full rounded-md border-2 border-accent-strong object-cover"
                      : "h-24 w-full rounded-md border-2 border-transparent object-cover opacity-50 hover:opacity-80"
                  }
                />
                <label className="flex items-center gap-1 text-caption text-ink-tertiary">
                  <input
                    type="checkbox"
                    className={CHECKBOX_CLASS}
                    data-testid="publish-asset"
                    data-asset-id={asset.id}
                    checked={selected.includes(asset.id)}
                    onChange={() => toggleAsset(asset.id)}
                  />
                  <span className="truncate">{asset.fileName}</span>
                </label>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-3 text-body">
            {downloadHref ? (
              <a
                href={downloadHref}
                download
                data-testid="publish-download"
                className={buttonClass({ variant: "secondary" })}
              >
                {PUBLISH_COPY.downloadAction}
              </a>
            ) : (
              <span
                aria-disabled="true"
                data-testid="publish-download-disabled"
                className="inline-flex min-h-9 cursor-not-allowed items-center justify-center rounded-md border border-line px-3.5 py-1.5 text-body text-ink-tertiary"
              >
                {PUBLISH_COPY.downloadAction}
              </span>
            )}
            <span className="text-footnote text-ink-tertiary">{PUBLISH_COPY.downloadZipHint}</span>
          </div>
        </section>

        <section className="space-y-3 text-body">
          <label className={FIELD_CLASS}>
            <span className={LABEL_CLASS}>{PUBLISH_COPY.titleLabel}</span>
            <input
              aria-label={PUBLISH_COPY.titleLabel}
              data-testid="publish-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <label className={FIELD_CLASS}>
            <span className={LABEL_CLASS}>{PUBLISH_COPY.bodyLabel}</span>
            <textarea
              aria-label={PUBLISH_COPY.bodyLabel}
              data-testid="publish-body"
              rows={6}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              className={TEXTAREA_CLASS}
            />
          </label>
          <label className={FIELD_CLASS}>
            <span className={LABEL_CLASS}>{PUBLISH_COPY.tagsLabel}</span>
            <input
              aria-label={PUBLISH_COPY.tagsLabel}
              data-testid="publish-tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              className={INPUT_CLASS}
            />
            <span className={HINT_CLASS}>{PUBLISH_COPY.tagsHint}</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="publish-copy"
              onClick={copyText}
              className={buttonClass({ variant: "secondary" })}
            >
              {PUBLISH_COPY.copyAction}
            </button>
          </div>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="publish-mark"
              onClick={markPublished}
              disabled={busy || selected.length === 0}
              className={buttonClass({ variant: "primary" })}
            >
              {PUBLISH_COPY.markPublishedAction}
            </button>
            {shareEntry}
          </div>
          <button
            type="button"
            data-testid="publish-close"
            onClick={onClose}
            className={buttonClass({ variant: "secondary" })}
          >
            {PUBLISH_COPY.closeAction}
          </button>
        </div>
      </div>
    </div>
  );
}
