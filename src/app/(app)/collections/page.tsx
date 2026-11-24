import Link from "next/link";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { COLLECTION_STATUS_TONE } from "@/components/ui/status-tone";
import {
  buttonClass,
 
  FIELD_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  PAGE_SUBTITLE_CLASS,
  PAGE_TITLE_CLASS,
  SELECT_CLASS,
} from "@/components/ui/styles";
import { firstValues } from "@/lib/search-params";
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

export default async function CollectionsPage({ searchParams }: PageProps) {
  const parsed = listCollectionsQuerySchema.safeParse(firstValues(await searchParams));
  // 参数不合法时退回默认查询，页面不因为手改 URL 而报错。
  const query = parsed.success ? parsed.data : listCollectionsQuerySchema.parse({});
  const list = await listCollections(query);
  const isFiltered = Boolean(query.q || query.status);

  return (
    <section className="mx-auto w-full max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className={PAGE_TITLE_CLASS}>{COLLECTION_COPY.listTitle}</h1>
          <p className={PAGE_SUBTITLE_CLASS}>{COLLECTION_COPY.listSubtitle}</p>
        </div>
        <CollectionDialog mode="create" />
      </div>

      <form action="/collections" method="get" className="flex flex-wrap items-end gap-3 text-body">
        <label className={FIELD_CLASS}>
          <span className={LABEL_CLASS}>搜索</span>
          <input
            type="search"
            name="q"
            defaultValue={query.q ?? ""}
            placeholder={COLLECTION_COPY.searchPlaceholder}
            className={`${INPUT_CLASS} sm:w-72`}
          />
        </label>
        <label className={FIELD_CLASS}>
          <span className={LABEL_CLASS}>{COLLECTION_COPY.statusFilterLabel}</span>
          <select
            name="status"
            defaultValue={query.status ?? ""}
            className={`${SELECT_CLASS} sm:w-56`}
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
          className={buttonClass({ variant: "secondary" })}
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
                <Link href={`/collections/${item.id}`} className="group block focus-visible:outline-offset-0">
                  {item.coverUrl ? (
                    // 鉴权路由读取原图缩略图，不走 Next 图片优化器。
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.coverUrl}
                      alt={item.name}
                      className="h-40 w-full object-cover transition-opacity group-hover:opacity-95"
                    />
                  ) : (
                    <div className="flex h-40 items-center justify-center bg-soft text-footnote text-ink-tertiary">
                      {COLLECTION_COPY.emptyAssets}
                    </div>
                  )}
                  <div className="space-y-2 border-t border-line p-4 text-body">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-ink">{item.name}</span>
                      <Pill tone={COLLECTION_STATUS_TONE[item.status]}>
                        {COLLECTION_STATUS_LABELS[item.status]}
                      </Pill>
                    </div>
                    <p className="text-footnote text-ink-tertiary">
                      {item.platform ?? COLLECTION_COPY.notFoundSource} · {item.createdAt.slice(0, 10)}
                    </p>
                    <p className="text-footnote text-ink-tertiary">{item.assetCount} 张原图</p>
                  </div>
                </Link>
              </Panel>
            </li>
          ))}
        </ul>
      )}

      <p className="text-footnote text-ink-tertiary">
        共 {list.total} 个资源夹 · 第 {list.page} 页 · 每页 {list.pageSize} 个
      </p>
    </section>
  );
}
