import { findFeatureFlag, type FeatureFlagKey } from "@/modules/feature-flags/registry";
import { isEnabled } from "@/modules/feature-flags/service";
import { FeatureGateFallback } from "./FeatureGateFallback";

export interface FeatureGateProps {
  feature: FeatureFlagKey;
  /** 关闭时按钮上显示的文字；默认用注册表里的功能名称。 */
  label?: string;
  /**
   * 开关打开时渲染的内容。可以省略：本版本有两个「界面保留、能力不做」的入口
   * （分享到小红书），它们永远走关闭分支，只渲染不可操作的占位按钮。
   */
  children?: React.ReactNode;
}

/**
 * 界面的唯一功能判定入口：可用则渲染 children，不可用则渲染禁用态占位。
 * 页面里不允许自己判断功能是否实现。
 */
export async function FeatureGate({ feature, label, children }: FeatureGateProps) {
  const entry = findFeatureFlag(feature);
  if (!entry) throw new Error(`未注册的功能开关：${feature}`);

  if (await isEnabled(feature)) {
    return <>{children}</>;
  }

  return <FeatureGateFallback label={label ?? entry.name} message={entry.disabledMessage} />;
}
