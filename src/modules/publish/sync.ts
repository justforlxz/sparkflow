/**
 * 结果被编辑后同步发布记录的标题快照（docs/prd/07 MUST 5）。
 *
 * 单独成文件是为了避开模块循环：创作结果模块调用它，而发布模块的 service 又要调用创作结果模块
 * 读取结果（读来源与图片）。这里只依赖 `repo.ts`，与 `generation/counts.ts` 是同一取舍。
 */
import { updateTitleSnapshot } from "./repo";

export async function syncPublishedTitle(
  resultId: string,
  title: string | null,
): Promise<void> {
  // `title` 为 null 表示结果还没有文案；记录里的快照用空字符串表示「当时没有标题」。
  await updateTitleSnapshot(resultId, title ?? "");
}
