"use client";

import { ErrorState } from "@/components/ui/ErrorState";
import {
  buttonClass,
  dialogClass,
  DIALOG_TITLE_CLASS,
  FIELD_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  OVERLAY_CLASS,
  TEXT_LINK_CLASS,
  TEXTAREA_CLASS,
} from "@/components/ui/styles";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ACCEPTED_IMAGE_MIME, COLLECTION_COPY } from "@/modules/media-collection/constants";
import type { CollectionAssetView } from "@/modules/media-collection/service";

/**
 * 新建 / 编辑弹窗。图片网格有三种状态（docs/prd/01-media-collection.md「范围」）：
 * 已保存（服务端已有）、待添加（本地选了文件还没上传）、待移除（打上删除标记但还没提交）。
 * 取消直接丢弃这些本地状态，不产生任何请求；保存时才把三种状态一次性落到服务端。
 * 编辑保存只发一次 `POST /api/collections/[id]/save`，服务端一个事务，失败不会留下部分改动。
 */

let pendingKeySeed = 0;

interface PendingFile {
  key: string;
  file: File;
  previewUrl: string;
}

export interface CollectionDialogValues {
  name: string;
  platform: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceBody: string;
}

export interface CollectionDialogProps {
  mode: "create" | "edit";
  /** 编辑时传入现有资源夹；新建时不需要。 */
  collection?: {
    id: string;
    values: CollectionDialogValues;
    assets: CollectionAssetView[];
  };
}

const EMPTY_VALUES: CollectionDialogValues = {
  name: "",
  platform: "",
  sourceUrl: "",
  sourceTitle: "",
  sourceBody: "",
};

const FIELD_LABELS: Array<{ key: keyof CollectionDialogValues; label: string; textarea?: boolean }> = [
  { key: "name", label: "名称" },
  { key: "platform", label: "来源平台" },
  { key: "sourceUrl", label: "来源链接" },
  { key: "sourceTitle", label: "原始标题" },
  { key: "sourceBody", label: "原始文案", textarea: true },
];

async function readEnvelope(response: Response): Promise<{ ok: boolean; message?: string }> {
  const body = (await response.json().catch(() => null)) as
    | { ok: true }
    | { ok: false; error: { message: string } }
    | null;

  if (response.ok && body?.ok) return { ok: true };
  if (body && !body.ok) return { ok: false, message: body.error.message };
  return { ok: false, message: `请求失败（HTTP ${response.status}）` };
}

function fieldsToFormData(values: CollectionDialogValues): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.append(key, value);
  return form;
}

export function CollectionDialog({ mode, collection }: CollectionDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<CollectionDialogValues>(collection?.values ?? EMPTY_VALUES);
  // 已保存的图片是服务端状态，只有「待添加」「待移除」是本地状态。
  const savedAssets: CollectionAssetView[] = collection?.assets ?? [];
  const [pendingRemove, setPendingRemove] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function resetLocalState() {
    for (const item of pendingFiles) URL.revokeObjectURL(item.previewUrl);
    setValues(collection?.values ?? EMPTY_VALUES);
    setPendingRemove([]);
    setPendingFiles([]);
    setError(null);
  }

  function openDialog() {
    resetLocalState();
    setOpen(true);
  }

  function closeDialog() {
    setOpen(false);
    resetLocalState();
  }

  function addFiles(files: FileList | null) {
    if (!files) return;
    const next = Array.from(files).map((file) => ({
      key: `pending-${(pendingKeySeed += 1)}`,
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    setPendingFiles((current) => [...current, ...next]);
  }

  function dropPendingFile(key: string) {
    setPendingFiles((current) => {
      const target = current.find((item) => item.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.key !== key);
    });
  }

  function toggleRemove(assetId: string) {
    setPendingRemove((current) =>
      current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId],
    );
  }

  async function saveCreate(): Promise<void> {
    const form = fieldsToFormData(values);
    for (const item of pendingFiles) form.append("images", item.file, item.file.name);

    const result = await readEnvelope(
      await fetch("/api/collections", { method: "POST", body: form }),
    );
    if (!result.ok) throw new Error(result.message ?? "保存失败");
  }

  async function saveEdit(): Promise<void> {
    const collectionId = collection?.id;
    if (!collectionId) throw new Error("缺少资源夹标识");

    // 清单顺序就是保存后的图片顺序：先已保存的（保留或移除），再本次新加的。
    const assets: Array<
      { kind: "keep"; assetId: string } | { kind: "remove"; assetId: string } | { kind: "add"; tempKey: string }
    > = savedAssets.map((asset) =>
      pendingRemove.includes(asset.id)
        ? { kind: "remove", assetId: asset.id }
        : { kind: "keep", assetId: asset.id },
    );
    for (const item of pendingFiles) assets.push({ kind: "add", tempKey: item.key });

    const form = new FormData();
    form.append("fields", JSON.stringify(values));
    form.append("assets", JSON.stringify(assets));
    for (const item of pendingFiles) form.append(`file:${item.key}`, item.file, item.file.name);

    const result = await readEnvelope(
      await fetch(`/api/collections/${collectionId}/save`, { method: "POST", body: form }),
    );
    if (!result.ok) throw new Error(result.message ?? "保存失败");
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      if (mode === "create") {
        await saveCreate();
      } else {
        await saveEdit();
      }
      setOpen(false);
      resetLocalState();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className={buttonClass({ variant: mode === "create" ? "primary" : "secondary" })}
      >
        {mode === "create" ? COLLECTION_COPY.createAction : COLLECTION_COPY.editAction}
      </button>

      {open ? (
        <div className={OVERLAY_CLASS}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={mode === "create" ? COLLECTION_COPY.createAction : COLLECTION_COPY.editAction}
            className={dialogClass({ width: "2xl", className: "space-y-5" })}
          >
            <h2 className={DIALOG_TITLE_CLASS}>
              {mode === "create" ? COLLECTION_COPY.createAction : COLLECTION_COPY.editAction}
            </h2>

            <div className="space-y-3">
              {FIELD_LABELS.map((field) => (
                <label key={field.key} className={FIELD_CLASS}>
                  <span className={LABEL_CLASS}>{field.label}</span>
                  {field.textarea ? (
                    <textarea
                      value={values[field.key]}
                      onChange={(event) =>
                        setValues((current) => ({ ...current, [field.key]: event.target.value }))
                      }
                      rows={4}
                      className={TEXTAREA_CLASS}
                    />
                  ) : (
                    <input
                      type="text"
                      value={values[field.key]}
                      onChange={(event) =>
                        setValues((current) => ({ ...current, [field.key]: event.target.value }))
                      }
                      className={INPUT_CLASS}
                    />
                  )}
                </label>
              ))}
            </div>

            <div className="space-y-2">
              <label className={FIELD_CLASS}>
                <span className={LABEL_CLASS}>{COLLECTION_COPY.addImagesLabel}</span>
                <input
                  type="file"
                  multiple
                  accept={ACCEPTED_IMAGE_MIME.join(",")}
                  onChange={(event) => addFiles(event.target.files)}
                  className="block w-full text-body text-ink-secondary file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-soft file:px-3 file:py-1.5 file:text-footnote file:font-medium file:text-ink hover:file:bg-line"
                />
              </label>

              <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                {savedAssets.map((asset) => {
                  const marked = pendingRemove.includes(asset.id);
                  return (
                    <li key={asset.id} className="space-y-1 text-footnote">
                      <div className="relative">
                        {/* eslint-disable-next-line @next/next/no-img-element -- 鉴权路由，不走 Next 图片优化器 */}
                        <img
                          src={asset.url}
                          alt={asset.fileName}
                          className={`h-20 w-full rounded-md border border-line object-cover ${marked ? "opacity-40" : ""}`}
                        />
                        <span className="absolute left-1 top-1 rounded-sm bg-panel/90 px-1 py-0.5 text-caption text-ink-secondary">
                          {marked ? COLLECTION_COPY.assetStatePendingRemove : COLLECTION_COPY.assetStateSaved}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleRemove(asset.id)}
                        className={`text-footnote ${TEXT_LINK_CLASS}`}
                      >
                        {marked ? COLLECTION_COPY.undoRemove : "移除"}
                      </button>
                    </li>
                  );
                })}

                {pendingFiles.map((item) => (
                  <li key={item.key} className="space-y-1 text-footnote">
                    <div className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element -- 本地预览，用 object URL */}
                      <img
                        src={item.previewUrl}
                        alt={item.file.name}
                        className="h-20 w-full rounded-md border border-line object-cover"
                      />
                      <span className="absolute left-1 top-1 rounded-sm bg-warning-soft px-1 py-0.5 text-caption text-warning">
                        {COLLECTION_COPY.assetStatePendingAdd}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => dropPendingFile(item.key)}
                      className={`text-footnote ${TEXT_LINK_CLASS}`}
                    >
                      {COLLECTION_COPY.dropPending}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {error ? <ErrorState message={error} /> : null}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={closeDialog}
                className={buttonClass({ variant: "secondary" })}
              >
                {COLLECTION_COPY.cancelAction}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className={buttonClass({ variant: "primary" })}
              >
                {saving ? "保存中…" : COLLECTION_COPY.saveAction}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
