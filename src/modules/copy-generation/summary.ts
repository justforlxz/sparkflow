/**
 * 文案版本的派生状态（发布页签用）：
 * 列表里哪些版本还该轮询进度，以及标题与生成时间在列表里怎么显示。
 *
 * 与 `extraction/summary.ts` 同一分工：页面只拿现成结论，不自己判断状态字符串。
 */
import { COPY_VERSION_ACTIVE_STATUSES } from "./constants";

/** 还没进终态（`queued` / `running`）：发布页签在存在这些版本时轮询。 */
export function isActiveVersion(status: string): boolean {
  return (COPY_VERSION_ACTIVE_STATUSES as readonly string[]).includes(status);
}

/** 还在生成的版本（保持传入顺序）：有这些版本时界面轮询进度，结束即停。 */
export function activeVersions<T extends { status: string }>(versions: readonly T[]): T[] {
  return versions.filter((version) => isActiveVersion(version.status));
}

/**
 * 列表里的标题只取第一行并去掉首尾空白（docs/prd/12 SHOULD：版本列表显示标题首行）。
 * 没有标题时返回空串，由调用方换成「（无标题）」这类文案。
 */
export function titleFirstLine(title: string | null): string {
  if (!title) return "";
  return title.split(/\r?\n/)[0]?.trim() ?? "";
}
/**
 * 列表里的生成时间：取服务端给的 ISO 字符串，显示成 `YYYY-MM-DD HH:mm`。
 * 不按本地时区换算 —— 与页面其它日期展示（`createdAt.slice(0, 10)`）同一口径，测试可断言。
 */
export function formatVersionTime(isoString: string): string {
  return `${isoString.slice(0, 10)} ${isoString.slice(11, 16)}`;
}
