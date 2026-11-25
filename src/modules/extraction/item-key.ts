/**
 * 提取条目（原图 × 类别）的键：`<sourceAssetId>|<category>`。
 *
 * 一份定义三处共用（MKACG-999）：worker 写进 `extraction_run.current_item_key`、
 * 结果卡算「这一格在跑还是排队」、界面记「哪一格点了重试」。
 * 只由服务端生成的 uuid 与类别 key 拼成，两者都不含 `|`，所以不会撞键。
 */
export function extractionItemKey(sourceAssetId: string, category: string): string {
  return `${sourceAssetId}|${category}`;
}
