import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/ui/EmptyState";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { COLLECTION_STATUS_TONE } from "@/components/ui/status-tone";
import {
  PAGE_SUBTITLE_CLASS,
  PAGE_TITLE_CLASS,
  TEXT_LINK_CLASS,
} from "@/components/ui/styles";
import { isAppError } from "@/lib/errors";
import { COLLECTION_COPY, COLLECTION_STATUS_LABELS } from "@/modules/media-collection/constants";
import { getCollection, type CollectionDetailView } from "@/modules/media-collection/service";
import { CollectionDialog } from "../collection-dialog";
import { DeleteCollectionButton } from "./delete-collection-button";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
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

/**
 * 资源夹详情：本节点只剩「原始素材」这一面（来源信息 + 原图）。
 *
 * 提取运行与素材库页签由 MKACG-939 落地，发布页签与发布记录页由 MKACG-940 落地；
 * 旧模型的「AI 创作结果」页签随数据层一起移除（ADR 0010、MKACG-938）。
 */
export default async function CollectionDetailPage({ params }: PageProps) {
  const { id } = await params;
  const collection = await loadCollection(id);

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
            <span>素材 {collection.libraryAssetCount} 条</span>
            <span>文案版本 {collection.copyVersionCount} 个</span>
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
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
                  {/* 缩略图是按钮：点开在站内弹窗看原图，不再开新标签页（docs/prd/07）。 */}
                  <ImageLightbox
                    image={asset}
                    openLabel="查看大图"
                    closeLabel="关闭"
                    thumbnailClassName="h-32 w-full rounded-md border border-line object-cover transition-opacity hover:opacity-90"
                  />
                  <span className="block truncate">{asset.fileName}</span>
                </li>
              ))}
            </ul>
          )}
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
    </section>
  );
}
