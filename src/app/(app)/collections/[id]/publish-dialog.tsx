"use client";

import { useState } from "react";
import { ErrorState } from "@/components/ui/ErrorState";
import { fetchJson } from "@/components/api";
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={PUBLISH_COPY.prepareTitle}
        className="max-h-full w-full max-w-2xl space-y-4 overflow-y-auto rounded-lg bg-white p-6 shadow-xl"
      >
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-zinc-900">{PUBLISH_COPY.prepareTitle}</h2>
          <p className="text-xs text-zinc-500">{PUBLISH_COPY.prepareIntro}</p>
        </div>

        {error ? <ErrorState message={error} /> : null}
        {notice ? (
          <p role="status" className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {notice}
          </p>
        ) : null}

        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-zinc-900">{PUBLISH_COPY.selectImagesLabel}</h3>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                data-testid="publish-select-all"
                onClick={() => setSelected(result.assets.map((asset) => asset.id))}
                className="rounded border border-zinc-300 px-2 py-1 text-zinc-600 hover:bg-zinc-100"
              >
                {PUBLISH_COPY.selectAllAction}
              </button>
              <button
                type="button"
                data-testid="publish-select-none"
                onClick={() => setSelected([])}
                className="rounded border border-zinc-300 px-2 py-1 text-zinc-600 hover:bg-zinc-100"
              >
                {PUBLISH_COPY.selectNoneAction}
              </button>
            </div>
          </div>

          {/* 与结果页签同一处提示：发布前让用户自己确认水印（MKACG-901 MUST 1）。 */}
          <p
            data-testid="publish-watermark-notice"
            className="break-words rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          >
            {PUBLISH_COPY.upstreamWatermarkNotice}
          </p>

          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {result.assets.map((asset) => (
              <li key={asset.id}>
                <label className="block space-y-1 text-xs text-zinc-600">
                  {/* 鉴权路由读取生成图片缩略图，不走 Next 图片优化器。 */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={asset.thumbnailUrl}
                    alt={asset.fileName}
                    className={
                      selected.includes(asset.id)
                        ? "h-24 w-full rounded border-2 border-zinc-900 object-cover"
                        : "h-24 w-full rounded border-2 border-transparent object-cover opacity-60"
                    }
                  />
                  <span className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      data-testid="publish-asset"
                      data-asset-id={asset.id}
                      checked={selected.includes(asset.id)}
                      onChange={() => toggleAsset(asset.id)}
                    />
                    <span className="truncate">{asset.fileName}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-3 text-sm">
            {downloadHref ? (
              <a
                href={downloadHref}
                download
                data-testid="publish-download"
                className="rounded border border-zinc-300 px-3 py-1.5 text-zinc-700 hover:bg-zinc-100"
              >
                {PUBLISH_COPY.downloadAction}
              </a>
            ) : (
              <span
                aria-disabled="true"
                data-testid="publish-download-disabled"
                className="cursor-not-allowed rounded border border-zinc-200 px-3 py-1.5 text-zinc-400"
              >
                {PUBLISH_COPY.downloadAction}
              </span>
            )}
            <span className="text-xs text-zinc-500">{PUBLISH_COPY.downloadZipHint}</span>
          </div>
        </section>

        <section className="space-y-3 text-sm">
          <label className="block space-y-1">
            <span className="block font-medium text-zinc-900">{PUBLISH_COPY.titleLabel}</span>
            <input
              aria-label={PUBLISH_COPY.titleLabel}
              data-testid="publish-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded border border-zinc-300 px-3 py-2"
            />
          </label>
          <label className="block space-y-1">
            <span className="block font-medium text-zinc-900">{PUBLISH_COPY.bodyLabel}</span>
            <textarea
              aria-label={PUBLISH_COPY.bodyLabel}
              data-testid="publish-body"
              rows={6}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              className="w-full rounded border border-zinc-300 px-3 py-2"
            />
          </label>
          <label className="block space-y-1">
            <span className="block font-medium text-zinc-900">{PUBLISH_COPY.tagsLabel}</span>
            <input
              aria-label={PUBLISH_COPY.tagsLabel}
              data-testid="publish-tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              className="w-full rounded border border-zinc-300 px-3 py-2"
            />
            <span className="block text-xs text-zinc-500">{PUBLISH_COPY.tagsHint}</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="publish-copy"
              onClick={copyText}
              className="rounded border border-zinc-300 px-3 py-1.5 text-zinc-700 hover:bg-zinc-100"
            >
              {PUBLISH_COPY.copyAction}
            </button>
          </div>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="publish-mark"
              onClick={markPublished}
              disabled={busy || selected.length === 0}
              className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60"
            >
              {PUBLISH_COPY.markPublishedAction}
            </button>
            {shareEntry}
          </div>
          <button
            type="button"
            data-testid="publish-close"
            onClick={onClose}
            className="rounded border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
          >
            {PUBLISH_COPY.closeAction}
          </button>
        </div>
      </div>
    </div>
  );
}
