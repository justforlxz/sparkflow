"use client";

import { EmptyState } from "@/components/ui/EmptyState";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { Panel } from "@/components/ui/Panel";
import { CHECKBOX_CLASS } from "@/components/ui/styles";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import { COLLECTION_COPY, QUAD_COPY } from "@/modules/media-collection/constants";
import { QUAD_KIND_LABELS, type QuadKind } from "@/modules/media-collection/quad";
import type { CollectionAssetView } from "@/modules/media-collection/service";
import { AddAssetsDialog } from "./add-assets-dialog";
import { QuadEditor } from "./quad-editor";

/**
 * 左栏「原始材料」（MKACG-974 范围 2）：网格缩略图、全选、已选计数与「添加」。
 *
 * 原图属于总资源库（ADR 0012 第 1 条），这一栏只决定「这次提取用哪几张」，
 * 增删图片本身走「添加」弹窗与编辑弹窗：从夹里移除不删照片。
 */
export interface SourceAssetsPanelProps {
  collectionId: string;
  collectionName: string;
  assets: CollectionAssetView[];
  selected: ReadonlySet<string>;
  onToggle(assetId: string): void;
  onToggleAll(): void;
  /** 图片增删或四角保存后重新拉一次服务端数据。 */
  onAdded(): void;
}

/** 原图上的框选状态：已校正时说明这次框的是哪种四角，未校正时如实说明（AC-QUAD-7）。 */
function quadBadge(kind: QuadKind | null): string {
  return kind ? QUAD_COPY.correctedBadge(QUAD_KIND_LABELS[kind]) : QUAD_COPY.uncorrectedBadge;
}

export function SourceAssetsPanel({
  collectionId,
  collectionName,
  assets,
  selected,
  onToggle,
  onToggleAll,
  onAdded,
}: SourceAssetsPanelProps) {
  const allSelected = assets.length > 0 && selected.size === assets.length;

  return (
    <Panel
      testId="panel-source"
      title={LIBRARY_COPY.sourcePanelTitle}
      className="min-[1240px]:flex min-[1240px]:h-full min-[1240px]:min-h-0 min-[1240px]:flex-col"
      bodyClassName="min-[1240px]:min-h-0 min-[1240px]:flex-1 min-[1240px]:overflow-y-auto"
      actions={
        <AddAssetsDialog
          collectionId={collectionId}
          collectionName={collectionName}
          existingAssetIds={assets.map((asset) => asset.id)}
          onAdded={onAdded}
        />
      }
    >
      {assets.length === 0 ? (
        <div className="space-y-2">
          <EmptyState
            message={COLLECTION_COPY.emptyAssets}
            hint={COLLECTION_COPY.emptyAssetsHint}
          />
        </div>
      ) : (
        <div className="space-y-3">
          <label className="flex flex-wrap items-center gap-2 text-footnote text-ink-secondary">
            <input
              type="checkbox"
              className={CHECKBOX_CLASS}
              checked={allSelected}
              onChange={onToggleAll}
              aria-label={LIBRARY_COPY.selectAllLabel}
            />
            <span data-testid="source-selected-count">
              {LIBRARY_COPY.selectedSourceCount(selected.size, assets.length)}
            </span>
          </label>

          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 min-[1240px]:grid-cols-2">
            {assets.map((asset) => (
              <li key={asset.id} className="space-y-1 text-caption text-ink-tertiary">
                {/* 缩略图是按钮：点开在站内弹窗看原图（docs/prd/07）。 */}
                <ImageLightbox
                  image={asset}
                  openLabel={LIBRARY_COPY.viewImage}
                  closeLabel={LIBRARY_COPY.closePreview}
                  thumbnailClassName="h-24 w-full rounded-md border border-line object-cover transition-opacity hover:opacity-90 min-[1240px]:h-[86px]"
                />
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className={CHECKBOX_CLASS}
                    checked={selected.has(asset.id)}
                    onChange={() => onToggle(asset.id)}
                    aria-label={`${LIBRARY_COPY.sourceAssetSelectLabel}：${asset.fileName}`}
                  />
                  <span className="block min-w-0 truncate">{asset.fileName}</span>
                </label>
                {/* 框选四角（MKACG-1001）：入口与状态放在一起，用户一眼能看出这张图校正了没有。 */}
                <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                  <span
                    data-testid="asset-quad-badge"
                    data-corrected={asset.quadKind ? "true" : "false"}
                    className="min-w-0 truncate"
                  >
                    {quadBadge(asset.quadKind)}
                  </span>
                  <QuadEditor
                    assetId={asset.id}
                    imageUrl={asset.url}
                    fileName={asset.fileName}
                    quad={asset.quad}
                    quadKind={asset.quadKind}
                    realSize={asset.realSize}
                    onSaved={onAdded}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
