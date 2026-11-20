import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { getDb } from "@/lib/db";
import type { GatewayProtocol } from "@/modules/gateway/constants";
import { findGatewayByProtocol } from "@/modules/gateway/repo";
import { createGateway, createVisionClient } from "@/modules/gateway/service";

/**
 * 视觉提取的网关选择（docs/prd/02 `magpie-vision`、06「视觉提取」；AC-06-8 的真实链路）：
 * `findGatewayByProtocol` 按协议过滤、取最近更新的一条；`createVisionClient` 用记录里的地址与
 * 解密后的密钥建客户端；密钥解不开时返回 `null`（文案阶段据此降级，不让任务失败）。
 *
 * 这里用真实数据库与真实加密：单测里那两处边界是桩，这条链路是线上跑的那条。
 */

const NAME_PREFIX = "集成-图片理解-";
const createdIds: string[] = [];

afterEach(async () => {
  await getDb().gateway.deleteMany({ where: { name: { startsWith: NAME_PREFIX } } });
  createdIds.length = 0;
});

async function addGateway(input: {
  protocol: GatewayProtocol;
  baseUrl: string;
  apiKey?: string;
  /** 显式压低/抬高 updatedAt，让「最近更新」这条规则可确定地断言。 */
  updatedAt?: Date;
}): Promise<string> {
  const name = `${NAME_PREFIX}${randomUUID().slice(0, 8)}`;
  const created = await createGateway({
    name,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey ?? "plain-vision-key",
  });
  createdIds.push(created.id);

  if (input.updatedAt) {
    await getDb().gateway.update({ where: { id: created.id }, data: { updatedAt: input.updatedAt } });
  }
  return created.id;
}

test("没有 magpie-vision 网关时返回 null，文案阶段据此降级", async () => {
  await addGateway({ protocol: "openai-chat", baseUrl: "https://text.example.com" });

  await expect(findGatewayByProtocol("magpie-vision")).resolves.toBeNull();
  await expect(createVisionClient()).resolves.toBeNull();
});

test("多条时取最近更新的一条；客户端用记录里的地址与解出来的密钥", async () => {
  const older = await addGateway({
    protocol: "magpie-vision",
    baseUrl: "https://old.example.com",
    apiKey: "old-key",
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  });
  const newest = await addGateway({
    protocol: "magpie-vision",
    baseUrl: "https://new.example.com",
    apiKey: "new-key",
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  });
  // 同名的其它协议网关不参与选择。
  await addGateway({ protocol: "magpie-mcp", baseUrl: "https://image.example.com" });

  const selected = await findGatewayByProtocol("magpie-vision");
  expect(selected?.id).toBe(newest);
  expect(selected?.id).not.toBe(older);

  const calls: { url: string; headers: Record<string, string> }[] = [];
  const responses = [
    () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "一只橘猫" }], isError: false },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error("响应用完了");
    return next();
  }) as unknown as typeof fetch;

  const client = await createVisionClient({ fetchImpl });
  await expect(client?.analyzeImage({ image: "data:image/jpeg;base64,AAA", prompt: "描述" })).resolves.toBe("一只橘猫");

  expect(calls[1]?.url).toBe("https://new.example.com/mcp/magpie/vision");
  expect(calls[1]?.headers.authorization).toBe("Bearer new-key");
});

test("最近一条的密钥解不开时返回 null，不抛错", async () => {
  await addGateway({ protocol: "magpie-vision", baseUrl: "https://ok.example.com" });
  // 直接写一条坏密文，模拟 AUTH_SECRET 变更后读不出来的记录。
  await getDb().gateway.create({
    data: {
      name: `${NAME_PREFIX}${randomUUID().slice(0, 8)}`,
      protocol: "magpie-vision",
      baseUrl: "https://broken.example.com",
      encryptedApiKey: "not-a-cipher",
      updatedAt: new Date("2027-01-01T00:00:00Z"),
    },
  });

  const selected = await findGatewayByProtocol("magpie-vision");
  expect(selected?.baseUrl).toBe("https://broken.example.com");

  await expect(createVisionClient()).resolves.toBeNull();
});
