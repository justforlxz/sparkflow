/**
 * mock 适配器的脚本标记（`GENERATION_ADAPTER=mock`，docs/acceptance.md 第 3 节）。
 *
 * 失败路径与「判定为不存在」都按脚本触发：请求的补充要求（`extraPrompt`）里带上下面某个标记，
 * 对应调用就按约定失败或判定，这样 e2e 能用真实请求驱动「整批失败」「某一项失败」
 * 「某个类别判定为不存在」，不需要测试接口或改环境变量。
 *
 * 标记集中在这里：适配器与用例都从这一份取，改一处即可。
 */
export const MOCK_SCRIPT_HINTS = {
  /** 每一次图片调用都失败：用来验证「全部失败时不入库」。 */
  failImage: "mock:fail-image-all",
  /** 只让第 n 次图片调用失败（后面接 `-<n>`）：验证 AC-LIB-2 的部分成功。 */
  failImageAt: "mock:fail-image-at",
  /** 文案生成直接失败：验证失败原因与「不产生版本内容」。 */
  failCopy: "mock:fail-copy",
  /** 每一次视觉判定都回「不存在」：验证 AC-LIB-12 的 `empty` 终态。 */
  visionAbsentAll: "mock:vision-absent-all",
  /** 只让第 n 次视觉判定回「不存在」（后面接 `-<n>`）：验证 AC-LIB-11 的 `skipped`。 */
  visionAbsentAt: "mock:vision-absent-at",
  /**
   * 每次图片调用先等 n 毫秒（后面接 `-<n>`）：验证界面上的进度条能真的走起来。
   * mock 出图只花几毫秒，不加延时的话一次多图提取在界面上抓不到「中间进度」。
   */
  delayImageMs: "mock:delay-image-ms",
} as const;

/** 延时上限：脚本标记只用于测试，不让人把一次提取拖成几分钟。 */
const MAX_MOCK_DELAY_MS = 5_000;

/** 从提示词里读「让第几次调用失败」或「让第几次判定为不存在」。 */
function mockIndexAt(prompt: string, hint: string): number | null {
  const matched = new RegExp(`${hint}-(\\d+)`).exec(prompt);
  if (!matched) return null;
  const index = Number.parseInt(matched[1] ?? "", 10);
  return Number.isInteger(index) && index > 0 ? index : null;
}

/**
 * 从提示词里读「让第几次调用失败」。
 * 与 `failImage` 是两条独立标记：`mock:fail-image-at-2` 只让第 2 次失败，不会被当成整体失败。
 */
export function mockFailImageAt(prompt: string): number | null {
  return mockIndexAt(prompt, MOCK_SCRIPT_HINTS.failImageAt);
}

/** 从补充要求里读「让第几次视觉判定回不存在」。 */
export function mockVisionAbsentAt(prompt: string | null | undefined): number | null {
  return prompt ? mockIndexAt(prompt, MOCK_SCRIPT_HINTS.visionAbsentAt) : null;
}

/**
 * 从提示词里读「每次图片调用先等多少毫秒」（`mock:delay-image-ms-250`）。
 * 超过上限按上限算；读不出来时返回 0，调用方不需要额外判断。
 */
export function mockDelayMs(prompt: string): number {
  const matched = new RegExp(`${MOCK_SCRIPT_HINTS.delayImageMs}-(\\d+)`).exec(prompt);
  if (!matched) return 0;
  const value = Number.parseInt(matched[1] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_MOCK_DELAY_MS) : 0;
}

/** 补充要求里是否带了这个标记。 */
export function hasMockHint(prompt: string | null | undefined, hint: string): boolean {
  return prompt?.includes(hint) ?? false;
}
