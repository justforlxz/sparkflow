/**
 * 素材库的删除与去重（MKACG-1006，纯函数）。
 *
 * 界面上的删除分两种读法，都只改「看得见的那一份」：
 *
 * - **删除**：从视图里去掉若干条素材，格子里那一格回到「未提取」；
 * - **只保留最新**：同一张原图同一类别重跑会叠加产物（`library_asset` 每次运行各写一条），
 *   这里算出「除最新一条以外的旧产物」，界面据此提供一次清理。
 *
 * 真正的删除请求由界面在撤销窗口结束后发出（`components/ui/Toast.tsx` 的 `onExpire`），
 * 所以这里只做视图过滤，不碰请求与状态。单测在 `library-edit.test.ts`。
 */
import type { LibraryAssetView, LibraryView } from "./view";

/** 同一张原图同一类别下，除最新一条外的旧产物（重跑叠加出来的重复堆积）。 */
export function duplicateLibraryAssets(library: LibraryView): LibraryAssetView[] {
  // 键与 `extractionItemKey` 同一口径：一张原图 × 一个类别就是一格。
  const newest = new Map<string, LibraryAssetView>();
  const stale: LibraryAssetView[] = [];

  for (const group of library.groups) {
    for (const asset of group.items) {
      const key = `${asset.sourceAssetId}|${asset.category}`;
      const current = newest.get(key);
      if (!current) {
        newest.set(key, asset);
        continue;
      }
      // 不依赖接口的排序：按生成时间比，新的留下，旧的两条里较旧的那条算重复。
      if (Date.parse(asset.createdAt) > Date.parse(current.createdAt)) {
        newest.set(key, asset);
        stale.push(current);
      } else {
        stale.push(asset);
      }
    }
  }

  return stale;
}

/**
 * 从视图里去掉若干条素材：条数跟着重算，只剩「判定为不存在」的组保留
 * （AC-LIB-12：用户要能看到为什么这次什么都没提取到），空组去掉。
 */
export function removeLibraryAssets(
  library: LibraryView,
  assetIds: ReadonlySet<string>,
): LibraryView {
  if (assetIds.size === 0) return library;

  const groups = library.groups
    .map((group) => ({
      ...group,
      items: group.items.filter((asset) => !assetIds.has(asset.id)),
    }))
    .filter((group) => group.items.length > 0 || group.skipped.length > 0);

  return {
    groups,
    total: groups.reduce((sum, group) => sum + group.items.length, 0),
  };
}
