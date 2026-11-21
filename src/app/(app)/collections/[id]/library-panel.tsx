"use client";

import { useState } from "react";
import { fetchJson } from "@/components/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { buttonClass } from "@/components/ui/styles";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import type { LibraryView } from "@/modules/extraction/view";
import type { CollectionDetailView } from "@/modules/media-collection/service";
import { LibraryGroups } from "./library-groups";

/**
 * 「素材库」页签（docs/prd/12「页面结构」第二行、MUST 3 / SHOULD）：
 * 提取产物按类别分组（组内生成时间倒序），每组给出数量；每条显示来源原图的小缩略图，
 * 可多选、可删除（二次确认）、点击在站内弹窗预览。
 *
 * 分组网格与「发布」页签共用 `LibraryGroups`；本页签只补「删除选中」这条操作。
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

      {library.total > 0 ? (
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
      ) : null}

      <LibraryGroups
        library={library}
        sourceAssets={collection.assets}
        selected={selected}
        onToggle={toggleAsset}
        selectLabel={LIBRARY_COPY.librarySelectLabel}
        emptyMessage={LIBRARY_COPY.emptyLibrary}
      />

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