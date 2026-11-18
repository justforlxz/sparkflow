import { describe, expect, it } from "vitest";
import { MAX_EXTRA_PROMPT_LENGTH, MAX_IMAGE_COUNT } from "./constants";
import { createTaskSchema } from "./schema";

const VALID = {
  visualStyle: "fresh",
  copyStyle: "story",
  imageCount: 4,
  extraPrompt: "强调自然光",
};

describe("创建任务的参数校验", () => {
  it("合法参数解析成功", () => {
    expect(createTaskSchema.parse(VALID)).toEqual(VALID);
  });

  it("缺少视觉方向或文案风格时拒绝", () => {
    expect(() => createTaskSchema.parse({ ...VALID, visualStyle: "" })).toThrow();
    expect(() => createTaskSchema.parse({ ...VALID, copyStyle: "   " })).toThrow();
  });

  it("目标张数超出 1–上限时拒绝", () => {
    expect(() => createTaskSchema.parse({ ...VALID, imageCount: 0 })).toThrow();
    expect(() => createTaskSchema.parse({ ...VALID, imageCount: MAX_IMAGE_COUNT + 1 })).toThrow();
    expect(() => createTaskSchema.parse({ ...VALID, imageCount: 2.5 })).toThrow();
  });

  it("补充要求可以为空或省略，空字符串归一成 null", () => {
    expect(createTaskSchema.parse({ ...VALID, extraPrompt: undefined }).extraPrompt).toBeUndefined();
    expect(createTaskSchema.parse({ ...VALID, extraPrompt: "  " }).extraPrompt).toBeNull();
    expect(createTaskSchema.parse({ ...VALID, extraPrompt: null }).extraPrompt).toBeNull();
  });

  it("补充要求超过长度上限时拒绝", () => {
    expect(() =>
      createTaskSchema.parse({ ...VALID, extraPrompt: "长".repeat(MAX_EXTRA_PROMPT_LENGTH + 1) }),
    ).toThrow();
  });
});
