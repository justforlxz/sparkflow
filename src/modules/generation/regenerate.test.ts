import { describe, expect, it } from "vitest";
import { EXTRACT_REQUIREMENTS } from "@/modules/image-generation/styles";
import { defaultRegenerateRequirement, isKnownExtractRequirement } from "./regenerate";

/**
 * 「重新生成」用的提取要求（docs/prd/07 MUST 3、AC-04-9）：
 * 新任务沿用自己选的提取要求；ADR 0009 之前的旧任务存的是已删除的视觉方向 key，
 * 原样回传会被服务端拒绝（AC-EX-3），因此必须退回登记表第一项、由界面让用户重选。
 */
describe("重新生成的提取要求", () => {
  it("登记表里的三项原样沿用", () => {
    for (const requirement of EXTRACT_REQUIREMENTS) {
      expect(isKnownExtractRequirement(requirement.value), requirement.value).toBe(true);
      expect(defaultRegenerateRequirement(requirement.value), requirement.value).toBe(
        requirement.value,
      );
    }
  });

  it("旧的视觉方向三项已不在登记表里，退回登记表第一项", () => {
    for (const legacy of ["fresh", "editorial", "product"]) {
      expect(isKnownExtractRequirement(legacy), legacy).toBe(false);
      expect(defaultRegenerateRequirement(legacy), legacy).toBe(EXTRACT_REQUIREMENTS[0].value);
    }
  });

  it("空值与陌生取值同样退回第一项，不把非法值传回服务端", () => {
    expect(defaultRegenerateRequirement("")).toBe(EXTRACT_REQUIREMENTS[0].value);
    expect(defaultRegenerateRequirement("sunset")).toBe(EXTRACT_REQUIREMENTS[0].value);
  });
});
