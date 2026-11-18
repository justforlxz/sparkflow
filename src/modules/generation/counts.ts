/**
 * 资源夹侧需要的任务/结果计数（docs/prd/01-media-collection.md 的派生状态与 AC-02-10）。
 *
 * 单独成文件是为了避开模块循环：资源夹的 service 要调用它，而本模块的 service 又要调用
 * 资源夹的 service（读来源信息）。这里只依赖 `repo.ts`，不依赖本模块的 service。
 */
import { countResultsWithoutPublishRecord, taskStore } from "./repo";
import type { CollectionUsage } from "./store";

export type { CollectionUsage };

export async function countCollectionUsage(collectionId: string): Promise<CollectionUsage> {
  return taskStore.countCollectionUsage(collectionId);
}

/**
 * 「待发布」：有结果、但该结果还没有发布记录的条数（docs/prd/09 MUST 1）。
 *
 * 判定落在本模块自己的结果行上（`publishRecord` 是发布模块在本表上声明的关系），
 * 不读发布记录表的内容。
 */
export async function countUnpublishedResults(): Promise<number> {
  return countResultsWithoutPublishRecord();
}
