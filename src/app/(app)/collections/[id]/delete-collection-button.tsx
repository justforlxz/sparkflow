"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { COLLECTION_COPY } from "@/modules/media-collection/constants";

interface DeleteCollectionButtonProps {
  collectionId: string;
}

/** 删除前二次确认（docs/prd/00-overview.md 全局规则 7）。 */
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
        onClick={() => setConfirming(true)}
        className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
      >
        {COLLECTION_COPY.deleteAction}
      </button>

      {confirming ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-6">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={COLLECTION_COPY.deleteConfirmTitle}
            className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-xl"
          >
            <h2 className="text-lg font-semibold text-zinc-900">
              {COLLECTION_COPY.deleteConfirmTitle}
            </h2>
            <p className="text-sm leading-6 text-zinc-600">{COLLECTION_COPY.deleteConfirmBody}</p>
            {error ? (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                {COLLECTION_COPY.cancelAction}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
              >
                {deleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
