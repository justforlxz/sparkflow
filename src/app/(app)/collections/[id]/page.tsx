import Link from "next/link";
import { notFound } from "next/navigation";
import { PAGE_TITLE_CLASS, TEXT_LINK_CLASS } from "@/components/ui/styles";
import { isAppError } from "@/lib/errors";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import { listExtractionRuns, listLibrary } from "@/modules/extraction/service";
import { getCollection, type CollectionDetailView } from "@/modules/media-collection/service";
import { CollectionWorkspace } from "./collection-workspace";
import { PublishPanel } from "./publish-panel";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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
 * 资源夹详情：三栏工作区（原始材料 / 处理结果 / 提取设置，ADR 0012 第 4 条、MKACG-974）。
 *
 * 页面只取数：资源夹、提取运行、素材库。三栏里的交互、轮询与刷新在 `CollectionWorkspace`，
 * 「按原图一张卡」的派生读法在 `modules/extraction/results.ts`（纯函数）。
 *
 * 文案与发布是下一个节点（MKACG-976）要下线的东西，三栏页面里没有它的位置；
 * 在它被删除之前用 `?view=publish` 保留一个入口，避免功能先变成不可达。
 */
export default async function CollectionDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const collection = await loadCollection(id);
  const [runs, library] = await Promise.all([
    listExtractionRuns(collection.id),
    listLibrary(collection.id),
  ]);
  const { view } = await searchParams;

  if (view === "publish") {
    return (
      <section className="mx-auto w-full max-w-5xl space-y-6">
        <Link href={`/collections/${collection.id}`} className={`text-footnote ${TEXT_LINK_CLASS}`}>
          ← {collection.name}
        </Link>
        <h1 className={PAGE_TITLE_CLASS}>{LIBRARY_COPY.publishTab}</h1>
        <div data-testid="panel-publish">
          <PublishPanel collection={collection} library={library} />
        </div>
      </section>
    );
  }

  return (
    <CollectionWorkspace
      collection={collection}
      initialRuns={runs}
      initialLibrary={library}
    />
  );
}
