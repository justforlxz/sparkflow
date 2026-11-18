-- CreateTable
CREATE TABLE "agent_config" (
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "name" TEXT NOT NULL,
    "gateway_id" TEXT,
    "gateway_model_id" TEXT,
    "role" TEXT NOT NULL,
    "system_prompt" TEXT NOT NULL,
    "output_requirements" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_config_pkey" PRIMARY KEY ("type")
);

-- AddForeignKey
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "gateway"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 预置两份固定配置（docs/prd/03-agent-config.md MUST 1）。
-- 默认文案与 src/modules/agent-config/defaults.ts 保持一致：单测会逐字段比对，避免两处漂移。
INSERT INTO "agent_config" ("type", "enabled", "name", "gateway_id", "gateway_model_id", "role", "system_prompt", "output_requirements", "updated_at")
VALUES
  (
    'image',
    true,
    '图片创作 Agent',
    NULL,
    NULL,
    '你是一名小红书图文创作者，负责把原始素材变成风格统一、可以直接发布的图片。',
    '根据用户给出的视觉方向与补充要求生成图片：素材主体保持真实，不添加素材里没有的文字、标识或人物；构图干净，色彩符合所选视觉方向。',
    '按目标张数输出图片，每张都是完整可用的成品图，不要拼接，不要加水印。',
    CURRENT_TIMESTAMP
  ),
  (
    'copy',
    true,
    '文案创作 Agent',
    NULL,
    NULL,
    '你是一名小红书文案撰写者，负责把原始素材与本次生成的图片写成可以直接发布的笔记。',
    '只依据原始素材与图片描述写作：不照搬原文，不编造参数、价格、功效与个人体验；语气自然、口语化，避免营销套话与夸张承诺。',
    '输出 JSON：title（不超过 30 字）、body（分段，不少于 80 字）、tags（话题标签，最多 10 个，不带 # 号）。',
    CURRENT_TIMESTAMP
  );
