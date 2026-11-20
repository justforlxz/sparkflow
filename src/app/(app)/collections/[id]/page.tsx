import Link from "next/link";
import { notFound } from "next/navigation";
import { FeatureGate } from "@/components/FeatureGate";
import { PublishRecordList } from "@/components/publish/publish-record-list";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { COLLECTION_STATUS_TONE } from "@/components/ui/status-tone";
import {
  PAGE_SUBTITLE_CLASS,
  PAGE_TITLE_CLASS,
  TEXT_LINK_CLASS,
} from "@/components/ui/styles";
import { isAppError } from "@/lib/errors";
import { listCollectionResults } from "@/modules/generation/results";
import { RESULT_COPY } from "@/modules/generation/constants";
import { COLLECTION_COPY, COLLECTION_STATUS_LABELS, MAX_PAGE_SIZE } from "@/modules/media-collection/constants";
import { getCollection, type CollectionDetailView } from "@/modules/media-collection/service";
import { PUBLISH_COPY } from "@/modules/publish/constants";
import { getPublishedResultIds, listPublishRecords } from "@/modules/publish/service";
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
  published: PUBLISH_COPY.collectionTab,
} as const;

type TabKey = keyof typeof TABS;

function resolveTab(value: string | string[] | undefined): TabKey {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === "results") return "results";
  if (first === "published") return "published";
  return "assets";
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
    <div className="flex gap-3 border-b border-line py-2 last:border-b-0">
      <dt className="w-24 shrink-0 text-ink-tertiary">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-ink">
        {value ?? COLLECTION_COPY.notFoundSource}
      </dd>
    </div>
  );
}

function tabClass(active: boolean): string {
  return active
    ? `-mb-px border-b-2 border-accent px-1 pb-2 text-body font-medium text-ink`
    : `-mb-px border-b-2 border-transparent px-1 pb-2 text-body text-ink-secondary hover:text-ink`;
}

export default async function CollectionDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const collection = await loadCollection(id);
  const tab = resolveTab((await searchParams).tab);
  const results = tab === "results" ? await listCollectionResults(id) : [];
  // 结果页签要展示每条结果的发布状态：只查 id，不在前端推断（docs/prd/07 MUST NOT）。
  const publishedResultIds =
    tab === "results" ? await getPublishedResultIds(results.map((result) => result.id)) : [];
  // 「发布记录」页签与全局 /published 页是同一个 service 的同一份数据。
  const publishedRecords =
    tab === "published"
      ? await listPublishRecords({ collectionId: id, page: 1, pageSize: MAX_PAGE_SIZE })
      : null;

  return (
    <section className="space-y-6">
      <Link href="/collections" className={`text-footnote ${TEXT_LINK_CLASS}`}>
        ← {COLLECTION_COPY.listTitle}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className={PAGE_TITLE_CLASS}>{collection.name}</h1>
          <p className={`flex flex-wrap items-center gap-3 ${PAGE_SUBTITLE_CLASS}`}>
            <Pill tone={COLLECTION_STATUS_TONE[collection.status]}>
              {COLLECTION_STATUS_LABELS[collection.status]}
            </Pill>
            <span>原图 {collection.assetCount} 张</span>
            <span>创作任务 {collection.taskCount} 个</span>
            <span>结果 {collection.resultCount} 个</span>
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <StartCreationDialog collectionId={collection.id} imageCount={collection.assetCount} />
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

      <nav aria-label="资源夹页签" className="flex gap-4 border-b border-line">
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
        <Link
          href={`/collections/${collection.id}?tab=published`}
          aria-current={tab === "published" ? "page" : undefined}
          className={tabClass(tab === "published")}
        >
          {TABS.published}
        </Link>
      </nav>

      {tab === "assets" ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-3">
            <h2 className="text-heading font-semibold text-ink">{COLLECTION_COPY.imagesSection}</h2>
            {collection.assets.length === 0 ? (
              <EmptyState
                message={COLLECTION_COPY.emptyAssets}
                hint={COLLECTION_COPY.emptyAssetsHint}
              />
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {collection.assets.map((asset) => (
                  <li key={asset.id} className="space-y-1 text-caption text-ink-tertiary">
                    <a
                      href={asset.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded-md"
                    >
                      {/* 鉴权路由读取原图缩略图，不走 Next 图片优化器。 */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={asset.url}
                        alt={asset.fileName}
                        className="h-32 w-full rounded-md border border-line object-cover"
                      />
                    </a>
                    <span className="block truncate">{asset.fileName}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* 图生图入口：本版本不实现，由功能开关渲染成禁用态，点击只提示、不发请求
                （docs/prd/05「本版本的范围边界」、docs/prd/10 AC-10-4）。 */}
            <FeatureGate feature="image-to-image" />
          </div>

          <Panel title={COLLECTION_COPY.sourceSection} className="h-fit min-w-0">
            <dl className="text-body">
              <SourceRow label="来源平台" value={collection.platform} />
              <SourceRow label="来源链接" value={collection.sourceUrl} />
              <SourceRow label="原始标题" value={collection.sourceTitle} />
              <SourceRow label="原始文案" value={collection.sourceBody} />
            </dl>
          </Panel>
        </div>
      ) : tab === "published" ? (
        <div className="space-y-3">
          <PublishRecordList
            records={publishedRecords?.items ?? []}
            emptyText={PUBLISH_COPY.emptyCollection}
          />
          {publishedRecords && publishedRecords.total > publishedRecords.items.length ? (
            <Link
              href={`/published?collectionId=${collection.id}`}
              className={`text-footnote ${TEXT_LINK_CLASS}`}
            >
              {PUBLISH_COPY.pageTitle}
            </Link>
          ) : null}
        </div>
      ) : results.length === 0 ? (
        <EmptyState
          message={RESULT_COPY.emptyList}
          action={
            <StartCreationDialog
              collectionId={collection.id}
              imageCount={collection.assetCount}
              variant="secondary"
              label={RESULT_COPY.emptyListAction}
            />
          }
        />
      ) : (
        <ResultsPanel
          results={results}
          publishedResultIds={publishedResultIds}
          // 分享入口由服务端开关决定渲染成什么，客户端组件里不判断功能是否实现（docs/prd/10）。
          shareEntry={<FeatureGate feature="share-to-xiaohongshu" />}
        />
      )}
    </section>
  );
}
