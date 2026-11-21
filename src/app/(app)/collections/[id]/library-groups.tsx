"use client";

import { EmptyState } from "@/components/ui/EmptyState";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { CHECKBOX_CLASS } from "@/components/ui/styles";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import type { LibraryAssetView, LibraryView } from "@/modules/extraction/view";
import type { CollectionDetailView } from "@/modules/media-collection/service";

/**
 * 素材库的分组网格（docs/prd/12「页面结构」MUST 3、SHOULD）：
 * 按类别分组（组内生成时间倒序），每组给出数量；每条显示来源原图的小缩略图，
 * 点击在站内弹窗预览。
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
  if (library.total === 0) return <EmptyState message={emptyMessage} />;

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
          </ul>
        </section>
      ))}
    </div>
  );
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
  const sourceLabel =
    asset.sourceAssetIndex === null
      ? LIBRARY_COPY.noSourceAssetLabel
      : `${LIBRARY_COPY.sourceAssetLabelPrefix} ${asset.sourceAssetIndex}`;

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
        <span className="min-w-0 truncate">{sourceLabel}</span>
      </p>
    </li>
  );
}