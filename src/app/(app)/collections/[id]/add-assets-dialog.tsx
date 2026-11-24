"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { fetchJson } from "@/components/api";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  buttonClass,
  CHECKBOX_CLASS,
  dialogClass,
  DIALOG_TITLE_CLASS,
  OVERLAY_CLASS,
  TEXT_LINK_CLASS,
} from "@/components/ui/styles";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import { ACCEPTED_IMAGE_MIME } from "@/modules/media-collection/constants";
import type { CollectionDetailView, PoolAssetList, PoolAssetView } from "@/modules/media-collection/service";

/**
 * 「添加」弹窗（MKACG-974 AC-UI-5、AC-UI-6）：两个来源页签。
 *
 * - **本地上传**：拖放 / 选文件 / ⌘V 粘贴，确认时走 `POST /api/collections/[id]/assets/upload`
 *   （入池 + 建关联一次事务，AC-POOL-6）；
 * - **从总资源库添加**：网格多选，已在夹内的照片置灰标「已加」，确认时走
 *   `POST /api/collections/[id]/assets`（只建关联，幂等，AC-POOL-5）。
 *
 * 底栏把两个来源拆开显示合计，用户点确认前就知道要加几张、从哪儿来。
 * 关闭有四种方式：× / 取消 / 点遮罩 / `Esc`，打开时焦点进弹窗、关闭后回到「添加」按钮。
 */

let pendingKeySeed = 0;

interface PendingFile {
  key: string;
  file: File;
  previewUrl: string;
}

type SourceTab = "upload" | "pool";

export interface AddAssetsDialogProps {
  collectionId: string;
  collectionName: string;
  /** 已经在夹里的原图 id：总资源库里这些照片置灰、标「已加」。 */
  existingAssetIds: readonly string[];
  /** 添加成功：父组件刷新服务端数据（左栏与顶部计数都跟着更新）。 */
  onAdded(): void;
}

export function AddAssetsDialog({
  collectionId,
  collectionName,
  existingAssetIds,
  onAdded,
}: AddAssetsDialogProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SourceTab>("upload");
  const [files, setFiles] = useState<PendingFile[]>([]);
  // `null` = 还没取过总资源库：切到那个页签才请求，打开弹窗不白拉一次列表。
  const [pool, setPool] = useState<PoolAssetView[] | null>(null);
  const [poolSelected, setPoolSelected] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const existing = new Set(existingAssetIds);
  const total = files.length + poolSelected.size;

  /** 只清本地文件与预览地址：两步提交里第一步成功后用它，第二步失败再点确认不会重复上传。 */
  const clearFiles = useCallback(() => {
    setFiles((current) => {
      for (const item of current) URL.revokeObjectURL(item.previewUrl);
      return [];
    });
  }, []);

  const resetLocalState = useCallback(() => {
    clearFiles();
    setPoolSelected(new Set());
    setTab("upload");
    setError(null);
    setDragging(false);
    // 总资源库列表下次打开重新取一次：本次上传进去的照片才会出现在「从总资源库添加」里。
    setPool(null);
  }, [clearFiles]);

  const close = useCallback(() => {
    setOpen(false);
    resetLocalState();
    triggerRef.current?.focus();
  }, [resetLocalState]);

  // `Esc` 关弹窗：只在打开时监听，遮罩与按钮共用同一个关闭动作。
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  // 总资源库按需取一次：切到那个页签才请求，打开弹窗不白拉一次列表。
  useEffect(() => {
    if (!open || tab !== "pool" || pool !== null) return;
    let cancelled = false;
    fetchJson<PoolAssetList>("/api/library?pageSize=60")
      .then((data) => {
        if (!cancelled) setPool(data.items);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "读取总资源库失败");
      });

    return () => {
      cancelled = true;
    };
  }, [open, tab, pool]);

  function openDialog() {
    resetLocalState();
    setOpen(true);
  }

  function addFiles(incoming: FileList | File[] | null) {
    if (!incoming) return;
    const accepted = Array.from(incoming).filter((file) =>
      (ACCEPTED_IMAGE_MIME as readonly string[]).includes(file.type),
    );
    if (accepted.length === 0) {
      setError("只接受 JPEG、PNG、WebP 图片");
      return;
    }
    setError(null);
    setFiles((current) => [
      ...current,
      ...accepted.map((file) => ({
        key: `pending-${(pendingKeySeed += 1)}`,
        file,
        previewUrl: URL.createObjectURL(file),
      })),
    ]);
  }

  function dropFiles(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  function dropPendingFile(key: string) {
    setFiles((current) => {
      const target = current.find((item) => item.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.key !== key);
    });
  }

  function togglePoolAsset(assetId: string) {
    setPoolSelected((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  async function uploadLocal(): Promise<void> {
    const form = new FormData();
    for (const item of files) form.append("images", item.file, item.file.name);
    await fetchJson<CollectionDetailView>(`/api/collections/${collectionId}/assets/upload`, {
      method: "POST",
      body: form,
    });
  }

  async function addFromPool(): Promise<void> {
    await fetchJson<CollectionDetailView>(`/api/collections/${collectionId}/assets`, {
      method: "POST",
      body: JSON.stringify({ assetIds: [...poolSelected] }),
    });
  }

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      // 先上传本地文件（它们同时入池），再建总库里的关联。
      // 第一步成功后立刻清空本地列表并通知父组件刷新：第二步失败时再点确认只重跑第二步，
      // 不会把同一批照片再上传一份；左栏也能马上看到第一步已经生效。
      if (files.length > 0) {
        await uploadLocal();
        clearFiles();
        onAdded();
      }
      if (poolSelected.size > 0) {
        await addFromPool();
        onAdded();
      }
      setOpen(false);
      resetLocalState();
      triggerRef.current?.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "添加失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="add-assets-open"
        onClick={openDialog}
        className={buttonClass({ variant: "primary", size: "sm" })}
      >
        {LIBRARY_COPY.addAction}
      </button>

      {open ? (
        <div className={OVERLAY_CLASS} onClick={close}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={LIBRARY_COPY.addDialogTitle(collectionName)}
            data-testid="add-assets-dialog"
            className={dialogClass({ width: "2xl", className: "space-y-4" })}
            onClick={(event) => event.stopPropagation()}
            onPaste={(event) => addFiles(event.clipboardData.files)}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h2 className={DIALOG_TITLE_CLASS}>{LIBRARY_COPY.addDialogTitle(collectionName)}</h2>
              <button
                ref={closeRef}
                type="button"
                aria-label={LIBRARY_COPY.closePreview}
                onClick={close}
                className={buttonClass({ variant: "ghost", size: "sm" })}
              >
                ×
              </button>
            </div>

            <div role="tablist" aria-label={LIBRARY_COPY.addAction} className="flex gap-1 border-b border-line">
              {(
                [
                  { value: "upload", label: LIBRARY_COPY.uploadTab },
                  { value: "pool", label: LIBRARY_COPY.poolTab },
                ] as const
              ).map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.value}
                  data-testid={`add-assets-tab-${entry.value}`}
                  onClick={() => setTab(entry.value)}
                  className={
                    tab === entry.value
                      ? "-mb-px border-b-2 border-accent px-3 py-2 text-body font-semibold text-ink"
                      : "-mb-px border-b-2 border-transparent px-3 py-2 text-body text-ink-secondary hover:text-ink"
                  }
                >
                  {entry.label}
                </button>
              ))}
            </div>

            {tab === "upload" ? (
              <div className="space-y-3">
                <div
                  data-testid="add-assets-dropzone"
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={dropFiles}
                  className={`space-y-2 rounded-md border border-dashed p-4 text-center text-body text-ink-secondary ${
                    dragging ? "border-accent bg-soft" : "border-line"
                  }`}
                >
                  <p>{LIBRARY_COPY.dropHint}</p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className={buttonClass({ variant: "secondary", size: "sm" })}
                  >
                    {LIBRARY_COPY.chooseFilesAction}
                  </button>
                  <p className="text-caption text-ink-tertiary">{LIBRARY_COPY.pasteHint}</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={ACCEPTED_IMAGE_MIME.join(",")}
                    aria-label={LIBRARY_COPY.chooseFilesAction}
                    data-testid="add-assets-file-input"
                    onChange={(event) => {
                      addFiles(event.target.files);
                      event.target.value = "";
                    }}
                    className="sr-only"
                  />
                </div>

                {files.length > 0 ? (
                  <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {files.map((item) => (
                      <li key={item.key} className="space-y-1 text-footnote">
                        {/* 本地预览用 object URL，还没上传，不经过鉴权路由。 */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={item.previewUrl}
                          alt={item.file.name}
                          className="h-20 w-full rounded-md border border-line object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => dropPendingFile(item.key)}
                          className={`text-footnote ${TEXT_LINK_CLASS}`}
                        >
                          {LIBRARY_COPY.removePendingFile}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <div className="space-y-2">
                {pool === null ? (
                  <p className="text-body text-ink-tertiary">读取总资源库…</p>
                ) : pool.length === 0 ? (
                  <p className="text-body text-ink-tertiary">{LIBRARY_COPY.poolEmpty}</p>
                ) : (
                  <ul className="grid max-h-[46vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
                    {pool.map((asset) => {
                      const added = existing.has(asset.id);
                      return (
                        <li
                          key={asset.id}
                          data-testid="add-assets-pool-item"
                          data-added={added ? "true" : "false"}
                          className={`space-y-1 text-caption ${added ? "opacity-50" : ""}`}
                        >
                          {/* 鉴权路由读取缩略图，不走 Next 图片优化器。 */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={asset.thumbnailUrl}
                            alt={asset.fileName}
                            className="h-20 w-full rounded-md border border-line object-cover"
                          />
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              className={CHECKBOX_CLASS}
                              disabled={added}
                              checked={added || poolSelected.has(asset.id)}
                              onChange={() => togglePoolAsset(asset.id)}
                              aria-label={`${LIBRARY_COPY.poolTab}：${asset.fileName}`}
                            />
                            <span className="block min-w-0 truncate">
                              {added ? LIBRARY_COPY.alreadyInCollection : asset.fileName}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {error ? <ErrorState message={error} /> : null}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
              <p data-testid="add-assets-summary" className="text-body text-ink-secondary">
                {LIBRARY_COPY.addSummary(total, files.length, poolSelected.size)}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="add-assets-cancel"
                  onClick={close}
                  className={buttonClass({ variant: "secondary", size: "sm" })}
                >
                  {LIBRARY_COPY.cancelAction}
                </button>
                <button
                  type="button"
                  data-testid="add-assets-confirm"
                  disabled={total === 0 || submitting}
                  onClick={() => void confirm()}
                  className={buttonClass({ variant: "primary", size: "sm" })}
                >
                  {submitting ? LIBRARY_COPY.submittingLabel : LIBRARY_COPY.addConfirmAction(total)}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
