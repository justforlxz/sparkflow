import Link from "next/link";
import { PUBLISH_COPY } from "@/modules/publish/constants";
import type { PublishRecordView } from "@/modules/publish/view";

/**
 * 发布记录列表：全局 `/published` 页与资源夹详情「发布记录」页签共用同一份渲染，
 * 两处看到的字段与顺序自然一致（docs/prd/08「发布记录」MUST）。
 */
interface PublishRecordListProps {
  records: PublishRecordView[];
  emptyText: string;
}

function formatTime(value: string): string {
  return value.slice(0, 16).replace("T", " ");
}

export function PublishRecordList({ records, emptyText }: PublishRecordListProps) {
  if (records.length === 0) {
    return (
      <p className="rounded border border-dashed border-zinc-300 bg-white px-4 py-10 text-center text-sm text-zinc-600">
        {emptyText}
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {records.map((record) => (
        <li
          key={record.id}
          data-testid="publish-record-item"
          data-result-id={record.resultId}
          className="flex gap-4 rounded-lg border border-zinc-200 bg-white p-4"
        >
          <Link
            href={`/collections/${record.collectionId}?tab=results`}
            className="block h-20 w-20 shrink-0 overflow-hidden rounded border border-zinc-200"
          >
            {record.thumbnailUrl ? (
              // 鉴权路由读取生成图片缩略图，不走 Next 图片优化器。
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={record.thumbnailUrl}
                alt={record.title || PUBLISH_COPY.noTitle}
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-xs text-zinc-400">
                {PUBLISH_COPY.noTitle}
              </span>
            )}
          </Link>

          <div className="min-w-0 space-y-1 text-sm">
            <p data-testid="publish-record-title" className="truncate font-medium text-zinc-900">
              {record.title || PUBLISH_COPY.noTitle}
            </p>
            <p className="text-xs text-zinc-500">
              {PUBLISH_COPY.publishedAtLabel} {formatTime(record.publishedAt)} ·{" "}
              {PUBLISH_COPY.imageCountLabel} {record.imageCount} 张 · {PUBLISH_COPY.platformLabel}{" "}
              {record.platform}
            </p>
            <p className="text-xs text-zinc-500">
              {PUBLISH_COPY.sourceCollectionLabel}{" "}
              <Link
                href={`/collections/${record.collectionId}?tab=published`}
                className="underline hover:text-zinc-900"
              >
                {record.collectionName}
              </Link>
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
