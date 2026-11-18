import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { listCollectionResults } from "@/modules/generation/results";
import { RESULT_COPY } from "@/modules/generation/constants";
import { COLLECTION_COPY, COLLECTION_STATUS_LABELS } from "@/modules/media-collection/constants";
import { getCollection, type CollectionDetailView } from "@/modules/media-collection/service";
import { CollectionDialog } from "../collection-dialog";
import { DeleteCollectionButton } from "./delete-collection-button";
import { ResultsPanel } from "./results-panel";
import { StartCreationDialog } from "./start-creation-dialog";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** 页签由 URL 参数决定：刷新与分享链接都能停在同一个页签上，不需要客户端状态。 */
const TABS = {
  assets: COLLECTION_COPY.assetTab,
  results: RESULT_COPY.tabLabel,
} as const;

type TabKey = keyof typeof TABS;

function resolveTab(value: string | string[] | undefined): TabKey {
  const first = Array.isArray(value) ? value[0] : value;
  return first === "results" ? "results" : "assets";
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

function tabClass(active: boolean): string {
  return active
    ? "-mb-px border-b-2 border-zinc-900 px-1 pb-2 font-medium text-zinc-900"
    : "-mb-px border-b-2 border-transparent px-1 pb-2 text-zinc-500 hover:text-zinc-900";
}

export default async function CollectionDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const collection = await loadCollection(id);
  const tab = resolveTab((await searchParams).tab);
  const results = tab === "results" ? await listCollectionResults(id) : [];

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
        <div className="flex flex-wrap items-start gap-2">
          <StartCreationDialog collectionId={collection.id} />
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
        <Link
          href={`/collections/${collection.id}`}
          aria-current={tab === "assets" ? "page" : undefined}
          className={tabClass(tab === "assets")}
        >
          {TABS.assets}
        </Link>
        <Link
          href={`/collections/${collection.id}?tab=results`}
          aria-current={tab === "results" ? "page" : undefined}
          className={tabClass(tab === "results")}
        >
          {TABS.results}
        </Link>
      </nav>

      {tab === "assets" ? (
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
      ) : results.length === 0 ? (
        <div className="space-y-3 rounded border border-dashed border-zinc-300 bg-white px-6 py-10 text-center">
          <p className="text-sm text-zinc-600">{RESULT_COPY.emptyList}</p>
          <StartCreationDialog
            collectionId={collection.id}
            variant="secondary"
            label={RESULT_COPY.emptyListAction}
          />
        </div>
      ) : (
        <ResultsPanel results={results} />
      )}
    </section>
  );
}
