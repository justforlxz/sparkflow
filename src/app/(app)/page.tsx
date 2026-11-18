import Link from "next/link";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { COLLECTION_STATUS_TONE } from "@/components/ui/status-tone";
import { DASHBOARD_COPY } from "@/modules/dashboard/constants";
import { getDashboardStats } from "@/modules/dashboard/service";
import { COLLECTION_STATUS_LABELS } from "@/modules/media-collection/constants";
import { CollectionDialog } from "./collections/collection-dialog";

// 统计随数据变化，页面在登录后才可访问。
export const dynamic = "force-dynamic";

/**
 * 工作台（docs/prd/09-dashboard.md「工作台」）。
 *
 * 四个统计数字与两份最近列表都来自 `getDashboardStats()`（`GET /api/stats` 的同一份数据），
 * 页面不做任何遍历计算，也没有演示数字：没有数据时显示空状态与引导（AC-09-1）。
 */
const STAT_CARDS = [
  {
    key: "collections",
    label: DASHBOARD_COPY.statCollections,
    hint: DASHBOARD_COPY.statCollectionsHint,
  },
  {
    key: "pendingGeneration",
    label: DASHBOARD_COPY.statPendingGeneration,
    hint: DASHBOARD_COPY.statPendingGenerationHint,
  },
  {
    key: "pendingPublish",
    label: DASHBOARD_COPY.statPendingPublish,
    hint: DASHBOARD_COPY.statPendingPublishHint,
  },
  {
    key: "published",
    label: DASHBOARD_COPY.statPublished,
    hint: DASHBOARD_COPY.statPublishedHint,
  },
] as const;

function formatDate(value: string): string {
  return value.slice(0, 10);
}

export default async function DashboardPage() {
  const stats = await getDashboardStats();

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-zinc-900">{DASHBOARD_COPY.title}</h1>
          <p className="max-w-2xl text-sm leading-6 text-zinc-600">{DASHBOARD_COPY.subtitle}</p>
        </div>
        <CollectionDialog mode="create" />
      </div>

      <dl
        aria-label={DASHBOARD_COPY.statsLabel}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        {STAT_CARDS.map((card) => (
          <Panel key={card.key}>
            <div className="space-y-1">
              <dt className="text-xs text-zinc-500">{card.label}</dt>
              <dd
                data-testid={`stat-${card.key}`}
                className="text-2xl font-semibold text-zinc-900"
              >
                {stats[card.key]}
              </dd>
              <p className="text-xs text-zinc-500">{card.hint}</p>
            </div>
          </Panel>
        ))}
      </dl>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel
          title={DASHBOARD_COPY.recentCollections}
          actions={
            <Link
              href="/collections"
              data-testid="dashboard-view-all"
              className="text-sm text-zinc-600 underline hover:text-zinc-900"
            >
              {DASHBOARD_COPY.viewAll}
            </Link>
          }
        >
          {stats.recentCollections.length === 0 ? (
            <EmptyState message={DASHBOARD_COPY.emptyCollections} />
          ) : (
            <ul className="space-y-3">
              {stats.recentCollections.map((collection) => (
                <li key={collection.id}>
                  <Link
                    href={`/collections/${collection.id}`}
                    data-testid="recent-collection"
                    data-collection-id={collection.id}
                    className="flex items-center gap-3 rounded border border-zinc-200 p-2 hover:bg-zinc-50"
                  >
                    {collection.coverUrl ? (
                      // 鉴权路由读取原图缩略图，不走 Next 图片优化器。
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={collection.coverUrl}
                        alt={collection.name}
                        className="h-12 w-12 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-zinc-100 text-center text-xs text-zinc-500">
                        {DASHBOARD_COPY.noCover}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="block truncate text-sm font-medium text-zinc-900">
                        {collection.name}
                      </span>
                      <span className="block text-xs text-zinc-500">
                        {collection.assetCount} {DASHBOARD_COPY.assetCountLabel} ·{" "}
                        {formatDate(collection.createdAt)}
                      </span>
                    </span>
                    <Pill tone={COLLECTION_STATUS_TONE[collection.status]}>
                      {COLLECTION_STATUS_LABELS[collection.status]}
                    </Pill>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={DASHBOARD_COPY.recentResults}>
          {stats.recentResults.length === 0 ? (
            <EmptyState
              message={DASHBOARD_COPY.emptyResults}
              action={
                <Link
                  href="/collections"
                  className="rounded border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                >
                  {DASHBOARD_COPY.emptyResultsAction}
                </Link>
              }
            />
          ) : (
            <ul className="space-y-3">
              {stats.recentResults.map((result) => (
                <li key={result.id}>
                  <Link
                    href={`/collections/${result.collectionId}?tab=results`}
                    data-testid="recent-result"
                    data-result-id={result.id}
                    className="flex items-center gap-3 rounded border border-zinc-200 p-2 hover:bg-zinc-50"
                  >
                    {result.thumbnailUrl ? (
                      // 鉴权路由读取生成图片缩略图，不走 Next 图片优化器。
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={result.thumbnailUrl}
                        alt={result.title ?? DASHBOARD_COPY.untitledResult}
                        className="h-12 w-12 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <span className="h-12 w-12 shrink-0 rounded bg-zinc-100" />
                    )}
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="block truncate text-sm font-medium text-zinc-900">
                        {result.title ?? DASHBOARD_COPY.untitledResult}
                      </span>
                      <span className="block truncate text-xs text-zinc-500">
                        {result.collectionName} · {formatDate(result.createdAt)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </section>
  );
}
