import Link from "next/link";
import { PublishRecordList } from "@/components/publish/publish-record-list";
import {
  buttonClass,
  FIELD_CLASS,
  LABEL_CLASS,
  PAGE_SUBTITLE_CLASS,
  PAGE_TITLE_CLASS,
  SELECT_CLASS,
  TEXT_LINK_CLASS,
} from "@/components/ui/styles";
import { MAX_PAGE_SIZE } from "@/modules/media-collection/constants";
import { listCollections } from "@/modules/media-collection/service";
import { PUBLISH_COPY } from "@/modules/publish/constants";
import { listPublishRecordsQuerySchema } from "@/modules/publish/schema";
import { listPublishRecords } from "@/modules/publish/service";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** 同名参数出现多次时取第一个：zod 收到数组会把它当成参数错误。 */
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `/published`：全局发布记录（docs/prd/08「发布记录」）。
 * 与资源夹详情「发布记录」页签调用同一个 service，因此两处数据与排序完全一致。
 */
export default async function PublishedPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const parsed = listPublishRecordsQuerySchema.safeParse({
    collectionId: firstValue(params.collectionId),
    page: firstValue(params.page),
  });
  // 手改 URL 传进非法参数时退回默认查询（第 1 页、不筛选），不把整页打成错误页
  // （AC-FIX-1、AC-FIX-2）。其它页面也是这个写法。
  const query = parsed.success ? parsed.data : listPublishRecordsQuerySchema.parse({});

  const [records, collections] = await Promise.all([
    listPublishRecords(query),
    // 筛选下拉要列出全部资源夹：发布记录只来自已有资源夹，不另造列表。
    listCollections({ page: 1, pageSize: MAX_PAGE_SIZE }),
  ]);

  const totalPages = Math.max(1, Math.ceil(records.total / records.pageSize));
  const pageHref = (page: number): string => {
    const search = new URLSearchParams();
    if (query.collectionId) search.set("collectionId", query.collectionId);
    if (page > 1) search.set("page", String(page));
    const suffix = search.toString();
    return suffix ? `/published?${suffix}` : "/published";
  };

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className={PAGE_TITLE_CLASS}>{PUBLISH_COPY.pageTitle}</h1>
        <p className={PAGE_SUBTITLE_CLASS}>{PUBLISH_COPY.pageSubtitle}</p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 text-body">
        <label className={`${FIELD_CLASS} w-full sm:w-auto`}>
          <span className={LABEL_CLASS}>{PUBLISH_COPY.filterLabel}</span>
          <select
            name="collectionId"
            aria-label={PUBLISH_COPY.filterLabel}
            defaultValue={query.collectionId ?? ""}
            className={`${SELECT_CLASS} w-full sm:w-64`}
          >
            <option value="">{PUBLISH_COPY.filterAll}</option>
            {collections.items.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {collection.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className={buttonClass({ variant: "secondary" })}
        >
          {PUBLISH_COPY.filterAction}
        </button>
      </form>

      <PublishRecordList records={records.items} emptyText={PUBLISH_COPY.emptyList} />

      {totalPages > 1 ? (
        <nav aria-label="分页" className="flex items-center gap-3 text-body">
          {query.page > 1 ? (
            <Link href={pageHref(query.page - 1)} className={TEXT_LINK_CLASS}>
              {PUBLISH_COPY.previousPage}
            </Link>
          ) : null}
          <span className="text-ink-tertiary">
            {query.page} / {totalPages}
          </span>
          {query.page < totalPages ? (
            <Link href={pageHref(query.page + 1)} className={TEXT_LINK_CLASS}>
              {PUBLISH_COPY.nextPage}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}
