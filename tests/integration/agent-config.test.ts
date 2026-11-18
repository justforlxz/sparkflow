import { afterEach, expect, test } from "vitest";
import { getDb } from "@/lib/db";
import { findAgentReferencesForGateway } from "@/modules/agent-config/references";

/**
 * Agent 配置的集成验收（docs/prd/03-agent-config.md MUST 1、MUST 7 的落库部分）：
 * 迁移是否真的预置了两条记录、网关被引用时的查询、网关删除后配置是否自动解绑。
 *
 * 这两条记录是全局固定的，用例结束必须把绑定还原成未绑定，避免影响后面的 e2e。
 */
const createdGatewayIds: string[] = [];

afterEach(async () => {
  await getDb().agentConfig.updateMany({ data: { gatewayId: null, gatewayModelId: null } });
  const ids = createdGatewayIds.splice(0);
  if (ids.length > 0) await getDb().gateway.deleteMany({ where: { id: { in: ids } } });
});

async function createGateway(name: string): Promise<string> {
  const gateway = await getDb().gateway.create({
    data: {
      name,
      protocol: "openai-chat",
      baseUrl: "https://gw.integration.example.com/v1",
      encryptedApiKey: "v1:aXY:dGFn:Y2lwaGVy",
    },
  });
  createdGatewayIds.push(gateway.id);
  return gateway.id;
}

test("迁移预置两条固定配置，类型只有 image 与 copy（MUST 1）", async () => {
  const rows = await getDb().agentConfig.findMany({
    orderBy: { type: "asc" },
    select: { type: true, enabled: true, gatewayId: true, gatewayModelId: true },
  });

  expect(rows).toEqual([
    { type: "copy", enabled: true, gatewayId: null, gatewayModelId: null },
    { type: "image", enabled: true, gatewayId: null, gatewayModelId: null },
  ]);
});

test("网关被 Agent 引用时能查出引用方（docs/prd/02 MUST 3）", async () => {
  const gatewayId = await createGateway("集成测试网关-引用");
  await getDb().agentConfig.update({
    where: { type: "copy" },
    data: { gatewayId, gatewayModelId: "gpt-4o-mini" },
  });

  expect(await findAgentReferencesForGateway(gatewayId)).toEqual([
    { source: "agent", name: "文案创作 Agent" },
  ]);
});

test("网关被删除时配置自动解绑，不指向不存在的网关（MUST 7 SHOULD）", async () => {
  const gatewayId = await createGateway("集成测试网关-删除");
  await getDb().agentConfig.update({
    where: { type: "image" },
    data: { gatewayId, gatewayModelId: null },
  });

  await getDb().gateway.delete({ where: { id: gatewayId } });

  const image = await getDb().agentConfig.findUnique({
    where: { type: "image" },
    select: { gatewayId: true },
  });
  expect(image?.gatewayId).toBeNull();
});
