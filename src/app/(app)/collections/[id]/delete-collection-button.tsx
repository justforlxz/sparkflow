"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { COLLECTION_COPY } from "@/modules/media-collection/constants";

interface DeleteCollectionButtonProps {
  collectionId: string;
}

/** 删除前二次确认（docs/prd/00-overview.md 全局规则 7）：弹窗复用通用 `ConfirmDialog`。 */
export function DeleteCollectionButton({ collectionId }: DeleteCollectionButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/collections/${collectionId}`, { method: "DELETE" });
      const body = (await response.json().catch(() => null)) as
        | { ok: true }
        | { ok: false; error: { message: string } }
        | null;

      if (!response.ok || !body || !body.ok) {
        throw new Error(body && !body.ok ? body.error.message : `请求失败（HTTP ${response.status}）`);
      }

      router.push("/collections");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
        className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
      >
        {COLLECTION_COPY.deleteAction}
      </button>

      <ConfirmDialog
        open={confirming}
        danger
        title={COLLECTION_COPY.deleteConfirmTitle}
        body={COLLECTION_COPY.deleteConfirmBody}
        confirmLabel={COLLECTION_COPY.deleteConfirmAction}
        busyLabel={COLLECTION_COPY.deletingLabel}
        cancelLabel={COLLECTION_COPY.cancelAction}
        busy={deleting}
        error={error}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}
