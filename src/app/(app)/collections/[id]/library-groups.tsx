"use client";

import { EmptyState } from "@/components/ui/EmptyState";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { CHECKBOX_CLASS } from "@/components/ui/styles";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import type { LibraryAssetView, LibraryView, SkippedItemView } from "@/modules/extraction/view";
import type { CollectionDetailView } from "@/modules/media-collection/service";

/**
 * 素材库的分组网格（docs/prd/12「页面结构」MUST 3、SHOULD、AC-LIB-11）：
 * 按类别分组（组内生成时间倒序），每组给出数量；每条显示来源原图的小缩略图，
 * 点击在站内弹窗预览。
 *
 * 判定为不存在的条目不是素材，但在组内如实显示「判定为不存在」与模型原话（可折叠）——
 * 视觉判定可能误判，误判要能在界面看出来（ADR 0011「风险」）。
 *
 * 「素材库」页签与「发布」页签共用这一份：分组规则、来源标签与缩略图行为只写一次，
 * 两个页签只决定勾选去做什么（删除 / 交给文案 Agent）。
 */
export interface LibraryGroupsProps {
  library: LibraryView;
  /** 资源夹的原图清单：用来显示「原图 N」的缩略图。 */
  sourceAssets: CollectionDetailView["assets"];
  selected: ReadonlySet<string>;
  onToggle(assetId: string): void;
  /** 勾选框的无障碍名称前缀（「选择这条素材」）。 */
  selectLabel: string;
  /** 没有素材时给出的下一步。 */
  emptyMessage: string;
}

export function LibraryGroups({
  library,
  sourceAssets,
  selected,
  onToggle,
  selectLabel,
  emptyMessage,
}: LibraryGroupsProps) {
  // 只有「判定为不存在」的组也要渲染：否则用户看不到「为什么这次什么都没提取到」。
  if (library.groups.length === 0) return <EmptyState message={emptyMessage} />;

  const sources = new Map(sourceAssets.map((asset) => [asset.id, asset]));

  return (
    <div className="space-y-6">
      {library.groups.map((group) => (
        <section
          key={group.category}
          data-testid={`library-group-${group.category}`}
          className="space-y-3"
        >
          <h2 className="text-heading font-semibold text-ink">
            {group.label}
            <span className="ml-2 text-footnote font-normal text-ink-tertiary">
              {group.items.length} {LIBRARY_COPY.itemCountSuffix}
            </span>
          </h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {group.items.map((asset) => (
              <LibraryItem
                key={asset.id}
                asset={asset}
                source={
                  asset.sourceAssetIndex === null
                    ? null
                    : (sources.get(asset.sourceAssetId) ?? null)
                }
                checked={selected.has(asset.id)}
                selectLabel={selectLabel}
                onToggle={() => onToggle(asset.id)}
              />
            ))}
            {group.skipped.map((item) => (
              <SkippedItem key={item.id} item={item} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** 来源原图的读法：「原图 N」；原图被解除关联时如实说明，不猜编号。 */
function sourceLabelOf(sourceAssetIndex: number | null): string {
  return sourceAssetIndex === null
    ? LIBRARY_COPY.noSourceAssetLabel
    : `${LIBRARY_COPY.sourceAssetLabelPrefix} ${sourceAssetIndex}`;
}

interface LibraryItemProps {
  asset: LibraryAssetView;
  /** 来源原图；原图被解除关联或已被删除时为 null，界面如实说明。 */
  source: CollectionDetailView["assets"][number] | null;
  checked: boolean;
  selectLabel: string;
  onToggle(): void;
}

function LibraryItem({ asset, source, checked, selectLabel, onToggle }: LibraryItemProps) {
  // 来源原图的序号取自服务端视图（原图被移除时是 null），界面不自己推编号。
  const sourceLabel = sourceLabelOf(asset.sourceAssetIndex);

  return (
    <li data-testid="library-item" className="space-y-1 text-caption text-ink-tertiary">
      <ImageLightbox
        image={asset}
        openLabel={LIBRARY_COPY.viewImage}
        closeLabel={LIBRARY_COPY.closePreview}
        thumbnailClassName="h-32 w-full rounded-md border border-line object-cover transition-opacity hover:opacity-90"
      />
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className={CHECKBOX_CLASS}
          checked={checked}
          onChange={onToggle}
          aria-label={`${selectLabel}：${asset.fileName}`}
        />
        <span className="block min-w-0 truncate">{asset.fileName}</span>
      </label>
      <p className="flex items-center gap-2">
        {source ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={source.thumbnailUrl}
            alt={sourceLabel}
            className="h-6 w-6 shrink-0 rounded-sm border border-line object-cover"
          />
        ) : null}
        <span className="block min-w-0 truncate">{sourceLabel}</span>
      </p>
    </li>
  );
}

/**
 * 一条「判定为不存在」的条目：没有图片可预览，也没有勾选框（它不是素材）。
 * 模型原话折叠在 `<details>` 里，展开才看得到依据。
 */
function SkippedItem({ item }: { item: SkippedItemView }) {
  return (
    <li
      data-testid="library-skipped-item"
      className="space-y-1 rounded-md border border-dashed border-line p-2 text-caption text-ink-tertiary"
    >
      <p className="text-body text-ink-secondary">{LIBRARY_COPY.skippedLabel}</p>
      <p className="truncate">{sourceLabelOf(item.sourceAssetIndex)}</p>
      <details>
        <summary className="cursor-pointer select-none">{LIBRARY_COPY.skipReasonLabel}</summary>
        <p
          data-testid="library-skipped-reason"
          className="mt-1 whitespace-pre-wrap break-words"
        >
          {item.reason}
        </p>
      </details>
    </li>
  );
}
