import Link from "next/link";
import { Pill } from "@/components/ui/Pill";
import { CARD_LINK_CLASS } from "@/components/ui/styles";
import { formatVersionTime } from "@/modules/copy-generation/summary";
import { PUBLISH_COPY } from "@/modules/publish/constants";
import type { PublishRecordView } from "@/modules/publish/view";

/**
 * 一条发布记录（docs/prd/08「发布记录」、docs/prd/12「页面结构」发布页签第 5 条）。
 *
 * 全局 `/published` 页与资源夹「发布」页签共用这一份：缩略图、标题快照、版本号、
 * 发布时间、素材数量与平台只写一次，两处显示不会各说一套。
 * `href` 有值时整行可点（全局页跳到来源资源夹），资源夹页签里不需要跳转。
 */
export interface PublishRecordItemProps {
  record: PublishRecordView;
  /** 全局页要显示「来源资源夹」；资源夹页签里不必重复。 */
  showCollection?: boolean;
  /** 整行跳转地址（全局页用来源资源夹详情）。 */
  href?: string;
}

export function PublishRecordItem({ record, showCollection = false, href }: PublishRecordItemProps) {
  const content = (
    <>
      {record.thumbnailUrl ? (
        // 鉴权路由读取素材缩略图，不走 Next 图片优化器。
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={record.thumbnailUrl}
          alt={record.title || PUBLISH_COPY.noTitle}
          className="h-12 w-12 shrink-0 rounded-md border border-line object-cover"
        />
      ) : (
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-soft text-center text-caption text-ink-tertiary">
          {PUBLISH_COPY.deletedAssetLabel}
        </span>
      )}
      <span className="min-w-0 flex-1 space-y-1">
        <span className="block text-footnote text-ink-tertiary">
          {record.versionLabel} · {PUBLISH_COPY.publishedAtLabel}{" "}
          {formatVersionTime(record.publishedAt)} · {record.platform} ·{" "}
          {PUBLISH_COPY.imageCountLabel} {record.imageCount} {PUBLISH_COPY.imageCountSuffix}
        </span>
        <span className="block truncate text-body text-ink">
          {record.title.trim() || PUBLISH_COPY.noTitle}
        </span>
        {showCollection ? (
          <span className="block truncate text-footnote text-ink-tertiary">
            {PUBLISH_COPY.sourceCollectionLabel}：{record.collectionName}
          </span>
        ) : null}
      </span>
      <Pill tone="published">{PUBLISH_COPY.statusPublished}</Pill>
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        data-testid="publish-record"
        data-version-no={record.versionNo}
        className={CARD_LINK_CLASS}
      >
        {content}
      </Link>
    );
  }

  return (
    <div
      data-testid="publish-record"
      data-version-no={record.versionNo}
      className="flex items-center gap-3 rounded-md border border-line bg-panel p-2.5"
    >
      {content}
    </div>
  );
}