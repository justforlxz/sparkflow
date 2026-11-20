import { describe, expect, it } from "vitest";
import { StageError } from "@/modules/generation/types";
import {
  IMAGE_FAILURE_FALLBACK_COPY,
  IMAGE_REJECTION_COPY,
  describeImageRejection,
  describeStageFailure,
} from "./failure";

/**
 * 生图失败摘要的拼装（MKACG-902 MUST 1、MUST 3）。
 *
 * 断言分两类：给出的说明必须指向可改的配置项；说明里不得出现上游原始回包的任何片段
 * （JSON 括号、`null`、上游域名、英文错误正文）。
 */

/** 上游原始回包不该出现在界面上的片段（AC-902-1 的判定清单）。 */
const UPSTREAM_FRAGMENTS = ["null", "{", "}", "api.", "Model does not exist", "siliconflow"];

function expectNoUpstreamText(message: string): void {
  for (const fragment of UPSTREAM_FRAGMENTS) {
    expect(message).not.toContain(fragment);
  }
}

describe("上游拒绝出图时的中文说明", () => {
  it("原文在说模型时，说明指向 Agent 绑定的模型（真实失败的原文）", () => {
    const raw =
      "no image: api.siliconflow.cn: 400 Bad Request: " +
      '{"code":20012,"message":"Model does not exist. Please check it carefully.","data":null}';

    const message = describeImageRejection(raw);

    expect(message).toBe(IMAGE_REJECTION_COPY.model);
    expect(message).toContain("模型");
    expect(message).toContain("设置页");
    expectNoUpstreamText(message);
  });

  it("原文没说模型时，说明指向提示词、尺寸与提取要求", () => {
    const message = describeImageRejection("no image: invalid n, should be in [1, 1]");

    expect(message).toBe(IMAGE_REJECTION_COPY.request);
    expect(message).toContain("提取要求");
    expect(message).not.toContain("invalid n");
  });

  it("没有原文时也给出一句可操作的中文说明，不退化成「生成失败」", () => {
    expect(describeImageRejection("")).toBe(IMAGE_REJECTION_COPY.request);
  });

  it("端点清单里的 /v1beta/models/* 不算在说模型（与连接测试同一份判定）", () => {
    expect(describeImageRejection('{"message":"magpie serves /v1beta/models/*"}')).toBe(
      IMAGE_REJECTION_COPY.request,
    );
  });
});

describe("阶段失败原因能不能直接给用户看", () => {
  it("适配器抛出的 StageError 已是中文说明，原样使用", () => {
    const message = "网关鉴权失败（HTTP 401），请到设置页检查网关 API Key";

    expect(describeStageFailure(new StageError("UPSTREAM_AUTH", message))).toBe(message);
  });

  it("内部异常的消息是英文内部信息，换成中文兜底", () => {
    const message = describeStageFailure(new TypeError("Cannot read properties of undefined"));

    expect(message).toBe(IMAGE_FAILURE_FALLBACK_COPY);
    expect(message).toContain("重试");
    expect(message).not.toContain("Cannot read");
  });

  it("StageError 的消息是空白时同样换成中文兜底", () => {
    expect(describeStageFailure(new StageError("STAGE_FAILED", "   "))).toBe(
      IMAGE_FAILURE_FALLBACK_COPY,
    );
  });
});
