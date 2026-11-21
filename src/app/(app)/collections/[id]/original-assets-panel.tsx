"use client";

import { useState } from "react";
import { fetchJson } from "@/components/api";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { EXTRACTION_STATUS_TONE } from "@/components/ui/status-tone";
import { buttonClass, CHECKBOX_CLASS, LABEL_CLASS } from "@/components/ui/styles";
import { SELECTABLE_CATEGORIES } from "@/modules/extraction/categories";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import { runFailureText, runProgressText } from "@/modules/extraction/summary";
import type { ExtractionRunView } from "@/modules/extraction/view";
import { EXTRACT_REQUIREMENTS } from "@/modules/image-generation/styles";
import { COLLECTION_COPY } from "@/modules/media-collection/constants";
import type { CollectionDetailView } from "@/modules/media-collection/service";

/**
 * 「原始素材」页签（docs/prd/12「页面结构」第一行、MUST 2/3）：
 * 原图网格可勾选（默认全选）+ 来源信息 + 提取要求三选一 + 类别多选 + 「AI 处理」。
 *
 * 发起后这个页签顶部显示进行中运行的进度（`progress.done / progress.total`，
 * 按 原图×类别 计），底部列出已结束的运行：`partial` / `failed` 带可读原因与失败项数量。
 * 素材与文案不在这个页签（AC-LIB-10）。
 */
export interface OriginalAssetsPanelProps {
  collection: CollectionDetailView;
  activeRuns: ExtractionRunView[];
  finishedRuns: ExtractionRunView[];
  onRunCreated(run: ExtractionRunView): void;
}

export function OriginalAssetsPanel({
  collection,
  activeRuns,
  finishedRuns,
  onRunCreated,
}: OriginalAssetsPanelProps) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(collection.assets.map((asset) => asset.id)),
  );
  const [requirement, setRequirement] = useState<string>(EXTRACT_REQUIREMENTS[0].value);
  const [categories, setCategories] = useState<Set<string>>(() => new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allSelected = collection.assets.length > 0 && selected.size === collection.assets.length;
  const canSubmit = selected.size > 0 && categories.size > 0 && !submitting;

  function toggleAsset(assetId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  function toggleAll(): void {
    setSelected(
      allSelected ? new Set() : new Set(collection.assets.map((asset) => asset.id)),
    );
  }

  function toggleCategory(value: string): void {
    setCategories((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      // 按资源夹里的原图顺序提交，勾选顺序不影响调用顺序。
      const sourceAssetIds = collection.assets
        .filter((asset) => selected.has(asset.id))
        .map((asset) => asset.id);
      const data = await fetchJson<{ run: ExtractionRunView }>(
        `/api/collections/${collection.id}/extractions`,
        {
          method: "POST",
          body: JSON.stringify({
            sourceAssetIds,
            categories: [...categories],
            requirement,
          }),
        },
      );
      onRunCreated(data.run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发起 AI 处理失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {activeRuns.length > 0 ? (
        <div
          data-testid="extraction-progress"
          className="space-y-1 rounded-md border border-line bg-panel px-3 py-2"
        >
          {activeRuns.map((run) => (
            <p key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-ink">
              <Pill tone={EXTRACTION_STATUS_TONE[run.status]}>{run.statusLabel}</Pill>
              <span data-testid="extraction-progress-text">{runProgressText(run)}</span>
              <span className="text-footnote text-ink-tertiary">
                {run.categoryLabels.join(" / ")}
              </span>
            </p>
          ))}
        </div>
      ) : null}

      {error ? <ErrorState message={error} /> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <h2 className="text-heading font-semibold text-ink">{COLLECTION_COPY.imagesSection}</h2>

          {collection.assets.length === 0 ? (
            <EmptyState
              message={COLLECTION_COPY.emptyAssets}
              hint={COLLECTION_COPY.emptyAssetsHint}
            />
          ) : (
            <div className="space-y-3">
              <label className="flex flex-wrap items-center gap-2 text-footnote text-ink-secondary">
                <input
                  type="checkbox"
                  className={CHECKBOX_CLASS}
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label={LIBRARY_COPY.selectAllLabel}
                />
                <span>
                  {LIBRARY_COPY.selectedAssetsLabel} {selected.size}/{collection.assets.length}{" "}
                  {LIBRARY_COPY.imageCountSuffix}
                </span>
              </label>

              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {collection.assets.map((asset) => (
                  <li key={asset.id} className="space-y-1 text-caption text-ink-tertiary">
                    {/* 缩略图是按钮：点开在站内弹窗看原图，不再开新标签页（docs/prd/07）。 */}
                    <ImageLightbox
                      image={asset}
                      openLabel={LIBRARY_COPY.viewImage}
                      closeLabel={LIBRARY_COPY.closePreview}
                      thumbnailClassName="h-32 w-full rounded-md border border-line object-cover transition-opacity hover:opacity-90"
                    />
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className={CHECKBOX_CLASS}
                        checked={selected.has(asset.id)}
                        onChange={() => toggleAsset(asset.id)}
                        aria-label={`${LIBRARY_COPY.sourceAssetSelectLabel}：${asset.fileName}`}
                      />
                      <span className="block min-w-0 truncate">{asset.fileName}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {collection.assets.length > 0 ? (
            <Panel className="min-w-0">
              <div className="space-y-4">
                <fieldset className="space-y-2">
                  <legend className={LABEL_CLASS}>{LIBRARY_COPY.requirementLabel}</legend>
                  {EXTRACT_REQUIREMENTS.map((entry) => (
                    <label key={entry.value} className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="extraction-requirement"
                        className={CHECKBOX_CLASS}
                        value={entry.value}
                        checked={requirement === entry.value}
                        onChange={() => setRequirement(entry.value)}
                      />
                      <span className="min-w-0">
                        <span className="block text-body text-ink">{entry.label}</span>
                        <span className="block text-caption text-ink-tertiary">
                          {entry.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>

                <fieldset className="space-y-2">
                  <legend className={LABEL_CLASS}>{LIBRARY_COPY.categoryLabel}</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {SELECTABLE_CATEGORIES.map((category) => (
                      <label
                        key={category.value}
                        className="flex items-center gap-2 text-body text-ink"
                      >
                        <input
                          type="checkbox"
                          className={CHECKBOX_CLASS}
                          checked={categories.has(category.value)}
                          onChange={() => toggleCategory(category.value)}
                        />
                        {category.label}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <button
                  type="button"
                  data-testid="extract-submit"
                  onClick={() => void submit()}
                  disabled={!canSubmit}
                  className={buttonClass({ variant: "primary" })}
                >
                  {submitting ? LIBRARY_COPY.extractingLabel : LIBRARY_COPY.extractAction}
                </button>
              </div>
            </Panel>
          ) : null}
        </div>

        <Panel title={COLLECTION_COPY.sourceSection} className="h-fit min-w-0">
          <dl className="text-body">
            <SourceRow label="来源平台" value={collection.platform} />
            <SourceRow label="来源链接" value={collection.sourceUrl} />
            <SourceRow label="原始标题" value={collection.sourceTitle} />
            <SourceRow label="原始文案" value={collection.sourceBody} />
          </dl>
        </Panel>
      </div>

      <Panel title={LIBRARY_COPY.runsTitle}>
        {finishedRuns.length === 0 ? (
          <p className="text-body text-ink-tertiary">{LIBRARY_COPY.emptyRuns}</p>
        ) : (
          <ul className="space-y-3">
            {finishedRuns.map((run) => {
              const failureText = runFailureText(run);
              return (
                <li key={run.id} data-testid="extraction-run" className="space-y-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-footnote text-ink-tertiary">
                    <Pill tone={EXTRACTION_STATUS_TONE[run.status]}>{run.statusLabel}</Pill>
                    <span>{run.createdAt.slice(0, 10)}</span>
                    <span>{run.categoryLabels.join(" / ")}</span>
                    <span>{run.requirementLabel}</span>
                    {failureText ? <span className="text-warning">{failureText}</span> : null}
                  </div>
                  {run.error ? <ErrorState message={run.error.message} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function SourceRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-3 border-b border-line py-2 last:border-b-0">
      <dt className="w-24 shrink-0 text-ink-tertiary">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-ink">
        {value ?? COLLECTION_COPY.notFoundSource}
      </dd>
    </div>
  );
}
