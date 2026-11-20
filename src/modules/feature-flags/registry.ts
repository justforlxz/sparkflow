/**
 * 功能开关注册表：声明有哪些开关、默认值、是否已实现、影响哪些界面与接口。
 * 新增一个开关只改这个文件（必要时加一条迁移预置默认值），不要在业务代码里加判断。
 */
export interface FeatureFlagEntry {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly defaultEnabled: boolean;
  /** 本版本是否已实现。`false` 时永远不可用，即使数据库里把 enabled 改成 true。 */
  readonly implemented: boolean;
  /** 受影响的界面与接口路径，便于验收逐条核对。 */
  readonly affects: readonly string[];
  /** 关闭时界面临时提示文案。 */
  readonly disabledMessage: string;
}

export const FEATURE_FLAGS = [
  {
    key: "image-to-image",
    name: "图生图",
    description: "把每张原始图片作为参考交给图片模型，一张原图生成一张成品图（ADR 0008）。",
    defaultEnabled: true,
    implemented: true,
    affects: ["资源夹详情的开始创作入口", "POST /api/collections/[id]/tasks"],
    disabledMessage: "该功能未启用",
  },
  {
    key: "share-to-xiaohongshu",
    name: "分享到小红书",
    description: "把内容直接发到小红书的对外动作。本版本不实现。",
    defaultEnabled: false,
    implemented: false,
    affects: ["任务结果的分享按钮"],
    disabledMessage: "分享功能不可用",
  },
] as const satisfies readonly FeatureFlagEntry[];

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[number]["key"];

export function findFeatureFlag(key: string): FeatureFlagEntry | undefined {
  return FEATURE_FLAGS.find((entry) => entry.key === key);
}
