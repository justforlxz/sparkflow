"use client";

import { useState } from "react";
import { fetchJson } from "@/components/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { buttonClass, CHECKBOX_CLASS } from "@/components/ui/styles";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import type { LibraryAssetView, LibraryView } from "@/modules/extraction/view";
import type { CollectionDetailView } from "@/modules/media-collection/service";

/**
 * 「素材库」页签（docs/prd/12「页面结构」第二行、MUST 3 / SHOULD）：
 * 提取产物按类别分组（组内生成时间倒序），每组给出数量；每条显示来源原图的小缩略图，
 * 可多选、可删除（二次确认）、点击在站内弹窗预览。
 *
 * 删除只删素材本身：引用它的文案版本仍能打开并显示「已删除素材」（MUST 4）。
 * 这里没有原图来源信息表单 —— 那是「原始素材」页签的东西（AC-LIB-10）。
 */
export interface LibraryPanelProps {
  collection: CollectionDetailView;
  library: LibraryView;
  onLibraryChanged(): Promise<void>;
}

export function LibraryPanel({ collection, library, onLibraryChanged }: LibraryPanelProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceAssets = new Map(collection.assets.map((asset) => [asset.id, asset]));

  function toggleAsset(assetId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  async function deleteSelected(): Promise<void> {
    setDeleting(true);
    setError(null);
    try {
      for (const assetId of selected) {
        await fetchJson<unknown>(`/api/library/${assetId}`, { method: "DELETE" });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除素材失败");
    } finally {
      // 整轮成功或中途失败都刷新素材库并清空选择：
      // 失败前已经删掉的条目要从界面消失；失效的 id 不能留在选择里，
      // 否则再点「确认删除」会在同一条上以「素材不存在」再次中止，剩下的素材再也删不掉。
      setSelected(new Set());
      setConfirming(false);
      try {
        await onLibraryChanged();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "素材库刷新失败");
      }
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      {error ? <ErrorState message={error} /> : null}

      {library.total === 0 ? (
        <EmptyState message={LIBRARY_COPY.emptyLibrary} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-body text-ink-secondary">
              {LIBRARY_COPY.selectedLibraryLabel} {selected.size} {LIBRARY_COPY.itemCountSuffix}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                disabled={selected.size === 0}
                className={buttonClass({ size: "sm" })}
              >
                {LIBRARY_COPY.clearSelection}
              </button>
              <button
                type="button"
                data-testid="library-delete"
                onClick={() => {
                  setError(null);
                  setConfirming(true);
                }}
                disabled={selected.size === 0}
                className={buttonClass({ variant: "danger", size: "sm" })}
              >
                {LIBRARY_COPY.deleteSelectedAction}
              </button>
            </div>
          </div>

          {library.groups.map((group) => (
            <section
              key={group.category}
              data-testid={`library-group-${group.category}`}
              className="space-y-3"
            >
              <h2 className="text-heading font-semibold text-ink">
                {group.label}
                <span className="ml-2 text-footnote font-normal text-ink-tertiary">
                  {group.items.length} {LIBRARY_COPY.itemCountSuffix}
                </span>
              </h2>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {group.items.map((asset) => (
                  <LibraryItem
                    key={asset.id}
                    asset={asset}
                    source={
                      asset.sourceAssetIndex === null
                        ? null
                        : (sourceAssets.get(asset.sourceAssetId) ?? null)
                    }
                    checked={selected.has(asset.id)}
                    onToggle={() => toggleAsset(asset.id)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}

      <ConfirmDialog
        open={confirming}
        danger
        title={LIBRARY_COPY.deleteConfirmTitle}
        body={LIBRARY_COPY.deleteConfirmBody}
        confirmLabel={LIBRARY_COPY.confirmDelete}
        busyLabel={LIBRARY_COPY.deletingLabel}
        cancelLabel={LIBRARY_COPY.cancelAction}
        busy={deleting}
        onCancel={() => {
          setConfirming(false);
          setError(null);
        }}
        onConfirm={() => void deleteSelected()}
      />
    </div>
  );
}

interface LibraryItemProps {
  asset: LibraryAssetView;
  /** 来源原图；原图被解除关联或已被删除时为 null，界面如实说明。 */
  source: CollectionDetailView["assets"][number] | null;
  checked: boolean;
  onToggle(): void;
}

function LibraryItem({ asset, source, checked, onToggle }: LibraryItemProps) {
  // 来源原图的序号取自服务端视图（原图被移除时是 null），界面不自己推编号。
  const sourceLabel =
    asset.sourceAssetIndex === null
      ? LIBRARY_COPY.noSourceAssetLabel
      : `${LIBRARY_COPY.sourceAssetLabelPrefix} ${asset.sourceAssetIndex}`;

  return (
    <li data-testid="library-item" className="space-y-1 text-caption text-ink-tertiary">
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
          checked={checked}
          onChange={onToggle}
          aria-label={`${LIBRARY_COPY.librarySelectLabel}：${asset.fileName}`}
        />
        <span className="block min-w-0 truncate">{asset.fileName}</span>
      </label>
      <p className="flex items-center gap-2">
        {source ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={source.thumbnailUrl}
            alt={sourceLabel}
            className="h-6 w-6 shrink-0 rounded-sm border border-line object-cover"
          />
        ) : null}
        <span className="min-w-0 truncate">{sourceLabel}</span>
      </p>
    </li>
  );
}
