import Link from "next/link";
import { PublishRecordItem } from "@/components/publish/publish-record-item";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  buttonClass,
  FIELD_CLASS,
  LABEL_CLASS,
  PAGE_SUBTITLE_CLASS,
  PAGE_TITLE_CLASS,
  SELECT_CLASS,
} from "@/components/ui/styles";
import { firstValues } from "@/lib/search-params";
import { listPublishRecords } from "@/modules/publish/service";
import { PUBLISH_COPY } from "@/modules/publish/constants";
import { listPublishRecordsQuerySchema } from "@/modules/publish/schema";
import { listCollectionOptions as loadCollectionOptions } from "@/modules/media-collection/service";

// 列表随数据变化，且页面在登录后才可访问。
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * 全局发布记录（docs/prd/08「发布记录」、docs/prd/09 MUST 1 的「发布记录」导航项）。
 *
 * 与资源夹「发布」页签同一份数据（`listPublishRecords`）、同一条记录组件，
 * 因此两边显示不会出现两份口径。可按来源资源夹筛选、按发布时间倒序翻页。
 * 记录只来自用户手动标记，系统不推断发布成功（docs/prd/08 MUST NOT）。
 */
export default async function PublishedPage({ searchParams }: PageProps) {
  const params = firstValues(await searchParams);
  const parsed = listPublishRecordsQuerySchema.safeParse(params);
  // 参数不合法时退回默认查询，页面不因为手改 URL 而报错。
  const query = parsed.success ? parsed.data : listPublishRecordsQuerySchema.parse({});

  const collections = await loadCollectionOptions();
  // 筛选了一个已被删除的资源夹：忽略筛选给出全部记录，而不是整页报错。
  const activeCollectionId =
    query.collectionId && collections.some((collection) => collection.id === query.collectionId)
      ? query.collectionId
      : undefined;
  const list = await listPublishRecords({ ...query, collectionId: activeCollectionId });

  const filtered = Boolean(activeCollectionId);
  const pageHref = (page: number): string => {
    const search = new URLSearchParams();
    if (activeCollectionId) search.set("collectionId", activeCollectionId);
    if (page > 1) search.set("page", String(page));
    const suffix = search.toString();
    return suffix ? `/published?${suffix}` : "/published";
  };
  const lastPage = Math.max(1, Math.ceil(list.total / list.pageSize));

  return (
    <section className="mx-auto w-full max-w-5xl space-y-6">
      <div className="space-y-1">
        <h1 className={PAGE_TITLE_CLASS}>{PUBLISH_COPY.pageTitle}</h1>
        <p className={`max-w-2xl ${PAGE_SUBTITLE_CLASS}`}>{PUBLISH_COPY.pageSubtitle}</p>
      </div>

      <form action="/published" method="get" className="flex flex-wrap items-end gap-3 text-body">
        <label className={FIELD_CLASS}>
          <span className={LABEL_CLASS}>{PUBLISH_COPY.filterLabel}</span>
          <select
            name="collectionId"
            defaultValue={activeCollectionId ?? ""}
            className={`${SELECT_CLASS} sm:w-64`}
          >
            <option value="">{PUBLISH_COPY.filterAll}</option>
            {collections.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {collection.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={buttonClass({ variant: "secondary" })}>
          {PUBLISH_COPY.filterAction}
        </button>
      </form>

      {list.items.length === 0 ? (
        <EmptyState
          message={filtered ? PUBLISH_COPY.emptyCollection : PUBLISH_COPY.emptyList}
        />
      ) : (
        <ul className="space-y-3">
          {list.items.map((record) => (
            <li key={record.id}>
              <PublishRecordItem
                record={record}
                showCollection
                href={`/collections/${record.collectionId}`}
              />
            </li>
          ))}
        </ul>
      )}

      {lastPage > 1 ? (
        <nav aria-label={PUBLISH_COPY.pageTitle} className="flex flex-wrap items-center gap-2">
          {list.page > 1 ? (
            <Link
              href={pageHref(list.page - 1)}
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              {PUBLISH_COPY.previousPage}
            </Link>
          ) : null}
          {list.page < lastPage ? (
            <Link
              href={pageHref(list.page + 1)}
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              {PUBLISH_COPY.nextPage}
            </Link>
          ) : null}
        </nav>
      ) : null}

      <p className="text-footnote text-ink-tertiary">
        {PUBLISH_COPY.listSummary(list.total, list.page, list.pageSize)}
      </p>
    </section>
  );
}