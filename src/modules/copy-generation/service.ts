/**
 * 文案阶段处理器（docs/prd/06-copy-generation.md）：读快照 → 取密钥 → 拼提示词 → 调文本模型 → 解析。
 *
 * 边界：
 * 1. 只从 `StageContext` 拿输入（快照、素材、参数），不查别的模块的表；
 * 2. 密钥按快照里的 `gatewayId` 现取（docs/prd/03 MUST 6：快照不含密钥），走网关模块的
 *    阶段执行入口，与生图阶段共用同一份实现；
 * 3. 模型、地址、接口形状都用快照里的值，之后改配置不影响已创建的任务（全局规则 4）；
 * 4. 落库由 runner 负责，这里只交 `CopyContent`。
 */
import { isAppError } from "@/lib/errors";
import { createVisionClient, getGatewayExecutionTarget } from "@/modules/gateway/service";
import type { StageRegistry } from "@/modules/generation/registry";
import { StageError, type StageContext, type StageHandler } from "@/modules/generation/types";
import { findTextGenerator } from "./adapters";
import type { TextGenerator } from "./adapters/types";
import { COPY_ERROR_CODES, DEFAULT_COPY_TIMEOUT_MS } from "./constants";
import { parseCopyContent } from "./parse";
import { buildCopyPrompt } from "./prompt";
import {
  extractVisualDescriptions,
  VISUAL_EXTRACTION_STATES,
  type VisionAnalyzer,
  type VisualExtractionState,
} from "./visual";

export interface CopyStageDeps {
  /** 按网关 id 取明文密钥；单测注入假实现，默认走网关服务。 */
  loadApiKey?: (gatewayId: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 整体替换文本适配器（单测与本地联调用假实现）；默认按快照里的接口形状选。 */
  generator?: TextGenerator;
  /** 单测注入：跳过 sharp，直接把原图字节当成 data URL 用（视觉提取用）。 */
  compress?: (bytes: Buffer) => Promise<string>;
  /**
   * 视觉提取用的客户端；单测注入假实现。`null` 表示没有可用的理解网关。
   * 不传时按 `magpie-vision` 网关现取（docs/prd/06）。
   */
  vision?: VisionAnalyzer | null;
}

/** 密钥取不到（网关被删、密钥解不开）归到鉴权失败：这一阶段没有可用的凭据。 */
async function revealApiKey(
  loadApiKey: (gatewayId: string) => Promise<string>,
  gatewayId: string,
): Promise<string> {
  try {
    return await loadApiKey(gatewayId);
  } catch (error) {
    if (isAppError(error)) {
      throw new StageError(COPY_ERROR_CODES.auth, error.message, { cause: error });
    }
    throw error;
  }
}

/**
 * 默认取密钥：走网关模块的阶段执行入口（`getGatewayExecutionTarget`），
 * 与生图阶段共用同一份实现，本模块不再保留第二份等价的解密逻辑。
 */
async function defaultLoadApiKey(gatewayId: string): Promise<string> {
  return (await getGatewayExecutionTarget(gatewayId)).apiKey;
}

export function createCopyStage(deps: CopyStageDeps = {}): StageHandler {
  const loadApiKey = deps.loadApiKey ?? defaultLoadApiKey;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_COPY_TIMEOUT_MS;

  return {
    stage: "copy",
    async run(context: StageContext) {
      const agent = context.agents.copy;

      if (!agent.enabled) {
        throw new StageError(COPY_ERROR_CODES.rejected, "文案创作 Agent 已停用，无法执行文案阶段");
      }
      if (!agent.modelId) {
        throw new StageError(COPY_ERROR_CODES.rejected, "文案创作 Agent 没有绑定模型");
      }

      const generator = deps.generator ?? findTextGenerator(agent.protocol);
      if (!generator) {
        throw new StageError(
          COPY_ERROR_CODES.rejected,
          `接口形状「${agent.protocol}」不支持文本生成`,
        );
      }
      const apiKey = await revealApiKey(loadApiKey, agent.gatewayId);

      // 文案要「把照片内容写出来」：先逐张读图拿到中文描述（docs/prd/06「视觉提取」）。
      // 读图走独立的 `magpie-vision` 网关，不要求文案模型自己具备 image_input；
      // 没有可用的理解网关、或识别失败时继续生成文案，但必须标注「未包含照片内容」。
      const vision =
        deps.vision !== undefined
          ? deps.vision
          : await createVisionClient(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
      let descriptions: string[] = [];
      let visualExtraction: VisualExtractionState;
      if (!vision) {
        visualExtraction = VISUAL_EXTRACTION_STATES.noGateway;
      } else {
        const extracted = await extractVisualDescriptions({
          analyzer: vision,
          assets: context.collection.assets,
          readSourceImage: context.readSourceImage,
          ...(deps.compress ? { compress: deps.compress } : {}),
          signal: context.signal,
        });
        descriptions = extracted.descriptions;
        visualExtraction = extracted.state;
      }

      const prompt = buildCopyPrompt({
        agent: {
          role: agent.role,
          systemPrompt: agent.systemPrompt,
          outputRequirements: agent.outputRequirements,
        },
        collection: {
          platform: context.collection.platform,
          sourceTitle: context.collection.sourceTitle,
          sourceBody: context.collection.sourceBody,
        },
        images: {
          generatedCount: context.collection.assets.length,
          descriptions,
          visualStyle: context.params.visualStyle,
        },
        copyStyle: context.params.copyStyle,
        extraPrompt: context.params.extraPrompt,
      });

      const startedAt = Date.now();
      const { text } = await generator.generate({
        baseUrl: agent.baseUrl,
        apiKey,
        modelId: agent.modelId,
        system: prompt.system,
        user: prompt.user,
        timeoutMs,
        signal: context.signal,
        fetchImpl: deps.fetchImpl,
      });
      const copy = parseCopyContent(text);

      return {
        stage: "copy",
        copy,
        meta: {
          protocol: agent.protocol,
          model: agent.modelId,
          totalMs: Date.now() - startedAt,
          titleLength: Array.from(copy.title).length,
          tagCount: copy.tags.length,
          /** 视觉提取的结局：界面据 `done` 之外的值标注「未包含照片内容」。 */
          visualExtraction,
          visualDescriptionCount: descriptions.length,
        },
      };
    },
  };
}

/** 接线处：`src/modules/generation/stages/index.ts` 在真实适配器下调用。 */
export function registerCopyGenerationStages(
  registry: StageRegistry,
  deps: CopyStageDeps = {},
): void {
  registry.register(createCopyStage(deps));
}
