import { z } from "zod";
import { AGENT_TYPE_VALUES } from "./constants";

/** `PATCH /api/agents/[type]`：字段都可省略，省略表示保持原值。 */
export const updateAgentConfigSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1, "名称不能为空").max(60, "名称过长").optional(),
  /** `null` 表示解除绑定；具体能否解绑由校验规则按类型判定。 */
  gatewayId: z.string().trim().max(200, "网关标识过长").nullable().optional(),
  gatewayModelId: z.string().trim().max(200, "模型名过长").nullable().optional(),
  role: z.string().trim().min(1, "角色说明不能为空").max(2000, "角色说明过长").optional(),
  systemPrompt: z
    .string()
    .trim()
    .min(1, "系统提示词不能为空")
    .max(8000, "系统提示词过长")
    .optional(),
  outputRequirements: z
    .string()
    .trim()
    .min(1, "输出要求不能为空")
    .max(4000, "输出要求过长")
    .optional(),
});

/** `GET /api/agents/models?type=image`。 */
export const agentModelQuerySchema = z.object({
  type: z.enum(AGENT_TYPE_VALUES, "不支持的 Agent 类型"),
});

export type UpdateAgentConfigInput = z.infer<typeof updateAgentConfigSchema>;
