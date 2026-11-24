import { describe, expect, it } from "vitest";
import { MOCK_SCRIPT_HINTS, mockDelayMs, mockFailImageAt, mockVisionAbsentAt } from "./mock-script";

/** 脚本标记的解析：标记写错时不报错、不中断，只是不生效（测试用例不该因为提示词里多打了字就崩）。 */
describe("mock 脚本标记", () => {
  it("读得出「第几次失败」与「第几次判定为不存在」", () => {
    expect(mockFailImageAt(`${MOCK_SCRIPT_HINTS.failImageAt}-2`)).toBe(2);
    expect(mockFailImageAt(MOCK_SCRIPT_HINTS.failImage)).toBeNull();
    expect(mockVisionAbsentAt(`${MOCK_SCRIPT_HINTS.visionAbsentAt}-1`)).toBe(1);
    expect(mockVisionAbsentAt(null)).toBeNull();
  });

  it("读得出每次图片调用的延时", () => {
    expect(mockDelayMs(`补充要求 ${MOCK_SCRIPT_HINTS.delayImageMs}-250`)).toBe(250);
    expect(mockDelayMs("没有标记")).toBe(0);
    expect(mockDelayMs(`${MOCK_SCRIPT_HINTS.delayImageMs}-0`)).toBe(0);
  });

  it("延时夹在上限内，不会被脚本标记拖成几分钟", () => {
    expect(mockDelayMs(`${MOCK_SCRIPT_HINTS.delayImageMs}-999999`)).toBe(5_000);
  });
});
