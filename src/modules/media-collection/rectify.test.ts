/**
 * 双线性取样的纯函数单测：重采样是「原样」的唯一实现细节，
 * 取样错一个像素就等于把文字挪位，所以这里按手工算出的期望值断言。
 */
import { describe, expect, test } from "vitest";
import { sampleBilinear, type RawImage } from "./rectify";

/** 2×2 的灰度图（单通道）：左上 0、右上 100、左下 200、右下 255。 */
function twoByTwo(): RawImage {
  return {
    data: Buffer.from([0, 100, 200, 255]),
    width: 2,
    height: 2,
    channels: 1,
  };
}

describe("sampleBilinear", () => {
  test("整数坐标取到完整的像素值", () => {
    const image = twoByTwo();
    expect(sampleBilinear(image, 0, 0, 0)).toBe(0);
    expect(sampleBilinear(image, 1, 0, 0)).toBe(100);
    expect(sampleBilinear(image, 0, 1, 0)).toBe(200);
    expect(sampleBilinear(image, 1, 1, 0)).toBe(255);
  });

  test("四格正中间是四个角的平均值", () => {
    const image = twoByTwo();
    expect(sampleBilinear(image, 0.5, 0.5, 0)).toBeCloseTo((0 + 100 + 200 + 255) / 4, 6);
  });

  test("沿水平方向是线性插值", () => {
    const image = twoByTwo();
    expect(sampleBilinear(image, 0.25, 0, 0)).toBeCloseTo(25, 6);
    expect(sampleBilinear(image, 0.75, 1, 0)).toBeCloseTo(200 + (255 - 200) * 0.75, 6);
  });

  test("越界坐标钳制到边缘像素，不返回黑色", () => {
    const image = twoByTwo();
    expect(sampleBilinear(image, -5, -5, 0)).toBe(0);
    expect(sampleBilinear(image, 99, 99, 0)).toBe(255);
    expect(sampleBilinear(image, 99, 0, 0)).toBe(100);
  });

  test("多通道时按通道偏移取值", () => {
    const rgb: RawImage = {
      data: Buffer.from([10, 20, 30, 40, 50, 60]),
      width: 2,
      height: 1,
      channels: 3,
    };
    expect(sampleBilinear(rgb, 0, 0, 0)).toBe(10);
    expect(sampleBilinear(rgb, 0, 0, 1)).toBe(20);
    expect(sampleBilinear(rgb, 1, 0, 2)).toBe(60);
  });
});
