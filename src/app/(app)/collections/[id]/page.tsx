import Link from "next/link";
import { notFound } from "next/navigation";
import { Pill } from "@/components/ui/Pill";
import { COLLECTION_STATUS_TONE } from "@/components/ui/status-tone";
import {
  PAGE_SUBTITLE_CLASS,
  PAGE_TITLE_CLASS,
  TEXT_LINK_CLASS,
} from "@/components/ui/styles";
import { isAppError } from "@/lib/errors";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import { listExtractionRuns, listLibrary } from "@/modules/extraction/service";
import { COLLECTION_COPY, COLLECTION_STATUS_LABELS } from "@/modules/media-collection/constants";
import { getCollection, type CollectionDetailView } from "@/modules/media-collection/service";
import { CollectionDialog } from "../collection-dialog";
import { CollectionTabs } from "./collection-tabs";
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

/**
 * 资源夹详情：页签「原始素材 / 素材库 / 发布」（docs/prd/12「页面结构」、ADR 0010）。
 *
 * 页面只做取数与页头；页签里的交互、轮询与刷新在 `CollectionTabs`。
 * 素材库数据在这里取一次给两个页签共用（素材库页签选删除、发布页签选素材）。
 */
export default async function CollectionDetailPage({ params }: PageProps) {
  const { id } = await params;
  const collection = await loadCollection(id);
  const [runs, library] = await Promise.all([
    listExtractionRuns(collection.id),
    listLibrary(collection.id),
  ]);

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
            <span>
              {LIBRARY_COPY.libraryTab} {collection.libraryAssetCount} 条
            </span>
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

      <CollectionTabs
        collection={collection}
        initialRuns={runs}
        initialLibrary={library}
      />
    </section>
  );
}
