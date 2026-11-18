import Link from "next/link";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { COLLECTION_STATUS_TONE } from "@/components/ui/status-tone";
import {
  COLLECTION_COPY,
  COLLECTION_STATUSES,
  COLLECTION_STATUS_LABELS,
} from "@/modules/media-collection/constants";
import { listCollectionsQuerySchema } from "@/modules/media-collection/schema";
import { listCollections } from "@/modules/media-collection/service";
import { CollectionDialog } from "./collection-dialog";

// 列表随数据变化，且页面在登录后才可访问。
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstValues(params: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") result[key] = first;
  }
  return result;
}

export default async function CollectionsPage({ searchParams }: PageProps) {
  const parsed = listCollectionsQuerySchema.safeParse(firstValues(await searchParams));
  // 参数不合法时退回默认查询，页面不因为手改 URL 而报错。
  const query = parsed.success ? parsed.data : listCollectionsQuerySchema.parse({});
  const list = await listCollections(query);
  const isFiltered = Boolean(query.q || query.status);

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-zinc-900">{COLLECTION_COPY.listTitle}</h1>
          <p className="text-sm text-zinc-600">{COLLECTION_COPY.listSubtitle}</p>
        </div>
        <CollectionDialog mode="create" />
      </div>

      <form action="/collections" method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="space-y-1">
          <span className="block font-medium text-zinc-900">搜索</span>
          <input
            type="search"
            name="q"
            defaultValue={query.q ?? ""}
            placeholder={COLLECTION_COPY.searchPlaceholder}
            className="w-full rounded border border-zinc-300 px-3 py-2 sm:w-72"
          />
        </label>
        <label className="space-y-1">
          <span className="block font-medium text-zinc-900">{COLLECTION_COPY.statusFilterLabel}</span>
          <select
            name="status"
            defaultValue={query.status ?? ""}
            className="max-w-full rounded border border-zinc-300 px-3 py-2"
          >
            <option value="">{COLLECTION_COPY.allStatuses}</option>
            {COLLECTION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {COLLECTION_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded border border-zinc-300 px-4 py-2 text-zinc-700 hover:bg-zinc-100"
        >
          {COLLECTION_COPY.searchAction}
        </button>
      </form>

      {list.items.length === 0 ? (
        <EmptyState message={isFiltered ? COLLECTION_COPY.emptySearch : COLLECTION_COPY.emptyList} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.items.map((item) => (
            <li key={item.id}>
              <Panel className="overflow-hidden" padded={false}>
                <Link href={`/collections/${item.id}`} className="block">
                  {item.coverUrl ? (
                    // 鉴权路由读取原图缩略图，不走 Next 图片优化器。
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.coverUrl}
                      alt={item.name}
                      className="h-40 w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-40 items-center justify-center bg-zinc-100 text-sm text-zinc-500">
                      {COLLECTION_COPY.emptyAssets}
                    </div>
                  )}
                  <div className="space-y-2 p-4 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-zinc-900">{item.name}</span>
                      <Pill tone={COLLECTION_STATUS_TONE[item.status]}>
                        {COLLECTION_STATUS_LABELS[item.status]}
                      </Pill>
                    </div>
                    <p className="text-zinc-500">
                      {item.platform ?? COLLECTION_COPY.notFoundSource} · {item.createdAt.slice(0, 10)}
                    </p>
                    <p className="text-zinc-500">{item.assetCount} 张原图</p>
                  </div>
                </Link>
              </Panel>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-zinc-500">
        共 {list.total} 个资源夹 · 第 {list.page} 页 · 每页 {list.pageSize} 个
      </p>
    </section>
  );
}
