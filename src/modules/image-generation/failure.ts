/**
 * 生图阶段失败的界面摘要（MKACG-902）：只说两件事 —— 发生了什么、用户该改哪一项配置。
 *
 * 上游的原始回包（JSON、英文错误正文、域名、`null`）不进数据库、不进接口响应、不进页面；
 * 它只按 `src/lib/logger.ts` 的脱敏规则写进服务端结构化日志，供排查（MUST 2）。
 *
 * 分类不在这里合并：`UPSTREAM_REJECTED` / `UPSTREAM_AUTH` / `UPSTREAM_TIMEOUT` /
 * `UPSTREAM_FORMAT` 的判定仍在适配器里，本文件只负责把原因说成中文。
 */
import { mentionsModel } from "@/modules/gateway/adapters/http";
import { StageError } from "@/lib/job-failure";

/** 上游拒绝出图时的中文说明：模型与请求参数要改的是不同配置项，分开写。 */
export const IMAGE_REJECTION_COPY = {
  /** 上游原文在说模型（不存在、不支持）：要改的是 Agent 绑定的模型。 */
  model: "上游不接受这个模型，请到设置页核对该图片 Agent 绑定的模型名称",
  /** 其余拒绝：提示词、尺寸、画质等请求参数不被接受。 */
  request: "上游不接受这次提取请求（提示词、尺寸或画质不被接受），请检查该 Agent 的配置与提取要求",
} as const;

/** 没有可读原因可给用户看时（例如内部异常）的一句中文说明，仍要指出下一步动作。 */
export const IMAGE_FAILURE_FALLBACK_COPY =
  "生图请求没有完成，请重试该阶段；若持续失败请查看服务端日志";

/**
 * 按上游原文挑一句中文说明。原文只参与判定（是不是在说模型），任何情况下都不回显。
 * 判定复用网关连接测试的 `mentionsModel`：同一份「上游在说模型」的判断只写一处。
 */
export function describeImageRejection(rawReason: string): string {
  return mentionsModel(rawReason) ? IMAGE_REJECTION_COPY.model : IMAGE_REJECTION_COPY.request;
}

/**
 * 失败原因能不能直接给用户看：只有适配器抛出的 `StageError` 是已写好的中文可操作说明；
 * 其余异常（TypeError、I/O 错误等）的消息是英文内部信息，只进日志。
 */
export function describeStageFailure(error: unknown): string {
  if (error instanceof StageError) {
    const message = error.message.trim();
    if (message.length > 0) return message;
  }
  return IMAGE_FAILURE_FALLBACK_COPY;
}
