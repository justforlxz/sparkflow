import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { COLLECTION_COPY, COLLECTION_STATUS_LABELS } from "@/modules/media-collection/constants";
import { getCollection, type CollectionDetailView } from "@/modules/media-collection/service";
import { CollectionDialog } from "../collection-dialog";
import { DeleteCollectionButton } from "./delete-collection-button";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

async function loadCollection(id: string): Promise<CollectionDetailView> {
  try {
    return await getCollection(id);
  } catch (error) {
    // 不存在的资源夹走 404 页面，不把接口错误码暴露到界面上。
    if (isAppError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}

function SourceRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-3 border-b border-zinc-100 py-2 last:border-b-0">
      <dt className="w-24 shrink-0 text-zinc-500">{label}</dt>
      <dd className="whitespace-pre-wrap break-words text-zinc-900">
        {value ?? COLLECTION_COPY.notFoundSource}
      </dd>
    </div>
  );
}

export default async function CollectionDetailPage({ params }: PageProps) {
  const { id } = await params;
  const collection = await loadCollection(id);

  return (
    <section className="space-y-6">
      <Link href="/collections" className="text-sm text-zinc-500 hover:text-zinc-900">
        ← {COLLECTION_COPY.listTitle}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-zinc-900">{collection.name}</h1>
          <p className="flex flex-wrap items-center gap-3 text-sm text-zinc-500">
            <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
              {COLLECTION_STATUS_LABELS[collection.status]}
            </span>
            <span>原图 {collection.assetCount} 张</span>
            <span>创作任务 {collection.taskCount} 个</span>
            <span>结果 {collection.resultCount} 个</span>
          </p>
        </div>
        <div className="flex items-start gap-2">
          <CollectionDialog
            mode="edit"
            collection={{
              id: collection.id,
              values: {
                name: collection.name,
                platform: collection.platform ?? "",
                sourceUrl: collection.sourceUrl ?? "",
                sourceTitle: collection.sourceTitle ?? "",
                sourceBody: collection.sourceBody ?? "",
              },
              assets: collection.assets,
            }}
          />
          <DeleteCollectionButton collectionId={collection.id} />
        </div>
      </div>

      <nav aria-label="资源夹页签" className="flex gap-4 border-b border-zinc-200 text-sm">
        <span
          aria-current="page"
          className="-mb-px border-b-2 border-zinc-900 px-1 pb-2 font-medium text-zinc-900"
        >
          {COLLECTION_COPY.assetTab}
        </span>
      </nav>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-3">
          <h2 className="text-base font-semibold text-zinc-900">{COLLECTION_COPY.imagesSection}</h2>
          {collection.assets.length === 0 ? (
            <p className="rounded border border-dashed border-zinc-300 bg-white px-4 py-8 text-center text-sm text-zinc-600">
              {COLLECTION_COPY.emptyAssets}
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {collection.assets.map((asset) => (
                <li key={asset.id} className="space-y-1 text-xs text-zinc-500">
                  <a href={asset.url} target="_blank" rel="noreferrer" className="block">
                    {/* 鉴权路由读取原图缩略图，不走 Next 图片优化器。 */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={asset.url}
                      alt={asset.fileName}
                      className="h-32 w-full rounded border border-zinc-200 object-cover"
                    />
                  </a>
                  <span className="block truncate">{asset.fileName}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <dl className="h-fit rounded-lg border border-zinc-200 bg-white p-4 text-sm">
          <h2 className="mb-2 text-base font-semibold text-zinc-900">
            {COLLECTION_COPY.sourceSection}
          </h2>
          <SourceRow label="来源平台" value={collection.platform} />
          <SourceRow label="来源链接" value={collection.sourceUrl} />
          <SourceRow label="原始标题" value={collection.sourceTitle} />
          <SourceRow label="原始文案" value={collection.sourceBody} />
        </dl>
      </div>
    </section>
  );
}
