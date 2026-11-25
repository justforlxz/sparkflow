/**
 * 设置页（docs/prd/03-agent-config.md「设置页结构」）。
 *
 * 一个页面、三个区块：网关（02）/ Agent（03）/ 功能开关（10）。
 * 三个区块共用卡片与表单组件，互不内联逻辑：页面只把各自的数据读好再交给区块。
 */
import { AgentSection } from "@/components/agents/AgentSection";
import { FeatureFlagSection } from "@/components/features/FeatureFlagSection";
import { GatewaySection } from "@/components/gateway/GatewaySection";
import { PAGE_SUBTITLE_CLASS, PAGE_TITLE_CLASS } from "@/components/ui/styles";
import { listAgentViews } from "@/modules/agent-config/service";
import { listFeatures } from "@/modules/feature-flags/service";
import { listGatewayViews } from "@/modules/gateway/service";

// 三个区块都是实时配置，不做静态预渲染。
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // 网关数据只读一次：Agent 区块的就绪判定与网关区块共用同一份。
  const gateways = await listGatewayViews();
  const agents = await listAgentViews(gateways);
  const features = await listFeatures();
  const gatewayOptions = gateways.map(({ id, name }) => ({ id, name }));

  return (
    <div className="mx-auto w-full max-w-5xl space-y-10">
      <header className="space-y-2">
        <h1 className={PAGE_TITLE_CLASS}>设置</h1>
        <p className={`max-w-2xl ${PAGE_SUBTITLE_CLASS}`}>
          模型与 Agent 设置：先配置模型网关，再让图片提取 Agent 从这里选择模型；最后是本版本的功能开关。
        </p>
      </header>

      <GatewaySection initialGateways={gateways} />
      <AgentSection initialAgents={agents} gatewayOptions={gatewayOptions} />
      <FeatureFlagSection initialFeatures={features} />
    </div>
  );
}
