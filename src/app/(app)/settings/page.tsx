/**
 * 设置页（docs/prd/03-agent-config.md「设置页结构」）。
 *
 * 一个页面、三个区块：网关 / Agent / 功能开关。
 * 本节点只交付网关区块；Agent 区块与功能开关区块由 N4 追加，区块之间共用卡片与表单组件、互不内联逻辑。
 */
import { GatewaySection } from "@/components/gateway/GatewaySection";
import { listGatewayViews } from "@/modules/gateway/service";

// 网关列表是实时配置，不做静态预渲染。
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const gateways = await listGatewayViews();

  return (
    <div className="space-y-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-zinc-900">设置</h1>
        <p className="max-w-2xl text-sm leading-6 text-zinc-600">
          模型与 Agent 设置：先配置模型网关，再让两个 Agent 从这里选择模型。
        </p>
      </header>

      <GatewaySection initialGateways={gateways} />
    </div>
  );
}
