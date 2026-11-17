import { z } from "zod";
import { GATEWAY_PROTOCOL_VALUES, MODEL_CAPABILITY_VALUES } from "./constants";

/**
 * Base URL 归一化：去掉尾部 `/`，避免拼出 `//chat/completions`（docs/prd/02 SHOULD）。
 * 只接受 http / https，其余（例如把密钥写进 URL）直接拒绝。
 */
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

const baseUrlSchema = z
  .string()
  .trim()
  .min(1, "Base URL 不能为空")
  .max(500, "Base URL 过长")
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(normalizeBaseUrl(value));
    } catch {
      ctx.addIssue({ code: "custom", message: "Base URL 必须是完整的 http(s) 地址" });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: "Base URL 只支持 http 或 https" });
    }
  })
  .transform(normalizeBaseUrl);

const gatewayNameSchema = z.string().trim().min(1, "网关名称不能为空").max(60, "网关名称过长");

export const gatewayProtocolSchema = z.enum(GATEWAY_PROTOCOL_VALUES, "不支持的接口形状");

export const modelCapabilitySchema = z.enum(MODEL_CAPABILITY_VALUES, "不支持的模型能力");

/** `POST /api/gateways`：新建时必须填密钥。 */
export const createGatewaySchema = z.object({
  name: gatewayNameSchema,
  protocol: gatewayProtocolSchema,
  baseUrl: baseUrlSchema,
  apiKey: z.string().trim().min(1, "API Key 不能为空").max(500, "API Key 过长"),
});

/**
 * `PATCH /api/gateways/[id]`：字段都可省略；`apiKey` 留空（或省略）= 保留原密钥（MUST 2）。
 */
export const updateGatewaySchema = z.object({
  name: gatewayNameSchema.optional(),
  protocol: gatewayProtocolSchema.optional(),
  baseUrl: baseUrlSchema.optional(),
  apiKey: z.string().trim().max(500, "API Key 过长").optional(),
});

/** `POST /api/gateways/[id]/models`。 */
export const createGatewayModelSchema = z.object({
  modelId: z.string().trim().min(1, "模型 ID 不能为空").max(200, "模型 ID 过长"),
  capability: modelCapabilitySchema,
});

/** `GET /api/gateways/models?capability=image`。 */
export const candidateQuerySchema = z.object({
  capability: modelCapabilitySchema,
});

export type CreateGatewayInput = z.infer<typeof createGatewaySchema>;
export type UpdateGatewayInput = z.infer<typeof updateGatewaySchema>;
export type CreateGatewayModelInput = z.infer<typeof createGatewayModelSchema>;
