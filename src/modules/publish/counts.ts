/**
 * 资源夹侧需要的发布记录计数（docs/prd/01 的派生状态 `published`）。
 *
 * 单独成文件是为了避开模块循环：资源夹的 service 要调用它，而本模块的 service 又要调用资源夹的
 * service（取资源夹名称）。这里只依赖 `repo.ts`，与 `generation/counts.ts` 是同一取舍。
 */
import { countRecords } from "./repo";

export async function countCollectionPublishRecords(collectionId: string): Promise<number> {
  return countRecords(collectionId);
}

/** 全部发布记录数：工作台「已发布」统计（docs/prd/09 MUST 1）。 */
export async function countAllPublishRecords(): Promise<number> {
  return countRecords();
}
