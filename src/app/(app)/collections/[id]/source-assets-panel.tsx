"use client";

import { EmptyState } from "@/components/ui/EmptyState";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { Panel } from "@/components/ui/Panel";
import { CHECKBOX_CLASS } from "@/components/ui/styles";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import { COLLECTION_COPY } from "@/modules/media-collection/constants";
import type { CollectionAssetView } from "@/modules/media-collection/service";
import { AddAssetsDialog } from "./add-assets-dialog";

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
  onAdded(): void;
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
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
