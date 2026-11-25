import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { listExtractionRuns, listLibrary } from "@/modules/extraction/service";
import { getCollection, type CollectionDetailView } from "@/modules/media-collection/service";
import { CollectionWorkspace } from "./collection-workspace";

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
 * 资源夹详情：三栏工作区（原始材料 / 处理结果 / 提取设置，ADR 0012 第 4 条、MKACG-974）。
 *
 * 页面只取数：资源夹、提取运行、素材库。三栏里的交互、轮询与刷新在 `CollectionWorkspace`，
 * 「按原图一张卡」的派生读法在 `modules/extraction/results.ts`（纯函数）。
 *
 * 文案与发布已下线，`?view=publish` 入口一并删除（ADR 0012 第 3 条、MKACG-976）。
 */
export default async function CollectionDetailPage({ params }: PageProps) {
  const { id } = await params;
  const collection = await loadCollection(id);
  const [runs, library] = await Promise.all([
    listExtractionRuns(collection.id),
    listLibrary(collection.id),
  ]);

  return (
    <CollectionWorkspace
      collection={collection}
      initialRuns={runs}
      initialLibrary={library}
    />
  );
}
