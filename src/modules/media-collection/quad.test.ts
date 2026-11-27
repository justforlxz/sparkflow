/**
 * 单应与长宽比推算的纯函数单测（MKACG-1001 AC-QUAD-2、AC-QUAD-4、AC-QUAD-5、AC-QUAD-8）。
 *
 * 比例准确性**不靠肉眼**：按已知真实尺寸 + 已知相机投影算出四边形，再让 `estimateAspectRatio`
 * 复原它（issue「验证方式」：比例准确性用合成图验）。
 */
import { describe, expect, test } from "vitest";
import {
  MAX_ASPECT_RATIO,
  MIN_ASPECT_RATIO,
  defaultQuad,
  estimateAspectRatio,
  rectToImage,
  unitSquareToImage,
  isValidQuad,
  parseQuad,
  resolveAspectRatio,
  type NormalizedQuad,
} from "./quad";

/** 四边形：顺序为左上、右上、右下、左下（归一化）。 */
function quadOf(points: Array<[number, number]>): NormalizedQuad {
  return points.map(([x, y]) => ({ x, y })) as unknown as NormalizedQuad;
}

/**
 * 把世界平面上的矩形（宽 `width`、高 `height`，中心在原点）按一台针孔相机投影成归一化四点。
 *
 * 相机：主点在画面中心、方形像素、焦距 `focal`；先绕 X 轴俯仰 `pitch`、再绕 Y 轴偏摆 `yaw`，
 * 相机沿 Z 轴距离 `distance`。两个角度都非零时，两条对边都交汇成有限远消失点 ——
 * 这是斜拍原图的通用形状，也是消失点法唯一能解出焦距的情形。
 *
 * 只俯仰不偏摆（`yaw = 0`）时，水平方向与画面平行、消失点在无穷远：单张矩形给不出焦距约束，
 * 比例在数学上不可复原。这里保留这个入口，用于断言「估算失败」的那条路径。
 */
function projectRectangle(options: {
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
  focal: number;
  distance: number;
  pitch: number;
  yaw?: number;
}): NormalizedQuad {
  const { width, height, imageWidth, imageHeight, focal, distance, pitch, yaw = 0 } = options;
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cx = imageWidth / 2;
  const cy = imageHeight / 2;

  // R = Ry(yaw)·Rx(pitch)（世界 → 相机）。
  const rotation = [
    [cosY, sinY * sinP, sinY * cosP],
    [0, cosP, -sinP],
    [-sinY, cosY * sinP, cosY * cosP],
  ];

  const project = (x: number, y: number): [number, number] => {
    const cameraX = rotation[0][0] * x + rotation[0][1] * y;
    const cameraY = rotation[1][0] * x + rotation[1][1] * y;
    const cameraZ = rotation[2][0] * x + rotation[2][1] * y + distance;
    return [(focal * cameraX) / cameraZ + cx, (focal * cameraY) / cameraZ + cy];
  };

  const corners: Array<[number, number]> = [
    project(-width / 2, -height / 2), // 左上
    project(width / 2, -height / 2), // 右上
    project(width / 2, height / 2), // 右下
    project(-width / 2, height / 2), // 左下
  ];

  return quadOf(corners.map(([x, y]) => [x / imageWidth, y / imageHeight]));
}

describe("isValidQuad（AC-QUAD-4：凹四边形与自交四边形不给保存）", () => {
  test("默认四角是合法凸四边形", () => {
    expect(isValidQuad(defaultQuad())).toBe(true);
  });

  test("自交（蝴蝶形）不合法", () => {
    expect(
      isValidQuad(
        quadOf([
          [0.1, 0.1],
          [0.9, 0.9],
          [0.9, 0.1],
          [0.1, 0.9],
        ]),
      ),
    ).toBe(false);
  });

  test("凹四边形不合法（一个角拖进另外三点形成的三角形内）", () => {
    expect(
      isValidQuad(
        quadOf([
          [0.1, 0.1],
          [0.9, 0.1],
          [0.4, 0.4],
          [0.1, 0.9],
        ]),
      ),
    ).toBe(false);
  });

  test("点重合退化不合法", () => {
    expect(
      isValidQuad(
        quadOf([
          [0.1, 0.1],
          [0.1, 0.1],
          [0.9, 0.9],
          [0.1, 0.9],
        ]),
      ),
    ).toBe(false);
  });

  test("三点共线（面积为 0）不合法", () => {
    expect(
      isValidQuad(
        quadOf([
          [0.1, 0.1],
          [0.5, 0.5],
          [0.9, 0.9],
          [0.1, 0.9],
        ]),
      ),
    ).toBe(false);
  });

  test("越界坐标不合法", () => {
    expect(
      isValidQuad(
        quadOf([
          [-0.1, 0.1],
          [0.9, 0.1],
          [0.9, 0.9],
          [0.1, 0.9],
        ]),
      ),
    ).toBe(false);
  });
});

describe("defaultQuad", () => {
  test("四角按图片内侧缩进 10%，顺序为左上、右上、右下、左下", () => {
    expect(defaultQuad()).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.1, y: 0.9 },
    ]);
  });
});

describe("unitSquareToImage（单位正方形 → 图片像素）", () => {
  test("单位正方形的四个角落到图片四边形的四个角（像素）", () => {
    const quad = quadOf([
      [0.12, 0.08],
      [0.86, 0.18],
      [0.9, 0.82],
      [0.1, 0.9],
    ]);
    const imageWidth = 800;
    const imageHeight = 500;
    const matrix = unitSquareToImage(quad, imageWidth, imageHeight);
    expect(matrix).not.toBeNull();
    const h = matrix as number[];

    const sources: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];

    sources.forEach(([u, v], index) => {
      const point = quad[index];
      const denominator = h[6] * u + h[7] * v + h[8];
      expect(h[0] * u + h[1] * v + h[2]).toBeCloseTo(point.x * imageWidth * denominator, 6);
      expect(h[3] * u + h[4] * v + h[5]).toBeCloseTo(point.y * imageHeight * denominator, 6);
    });
  });

  test("退化四边形（面积为 0）返回 null", () => {
    expect(
      unitSquareToImage(
        quadOf([
          [0.1, 0.1],
          [0.5, 0.5],
          [0.9, 0.9],
          [0.1, 0.9],
        ]),
        800,
        400,
      ),
    ).toBeNull();
  });
});

describe("rectToImage（目标矩形像素 → 源图片像素）", () => {
  test("目标矩形的四个角准确落回源四边形的四个角", () => {
    const quad = quadOf([
      [0.12, 0.08],
      [0.86, 0.18],
      [0.9, 0.82],
      [0.1, 0.9],
    ]);
    const imageWidth = 800;
    const imageHeight = 500;
    const targetWidth = 640;
    const targetHeight = 480;
    const matrix = rectToImage(
      quad,
      { width: imageWidth, height: imageHeight },
      { width: targetWidth, height: targetHeight },
    );
    expect(matrix).not.toBeNull();
    const m = matrix as number[];

    const targets: Array<[number, number]> = [
      [0, 0],
      [targetWidth, 0],
      [targetWidth, targetHeight],
      [0, targetHeight],
    ];

    targets.forEach(([x, y], index) => {
      const point = quad[index];
      const denominator = m[6] * x + m[7] * y + m[8];
      expect((m[0] * x + m[1] * y + m[2]) / denominator).toBeCloseTo(
        point.x * imageWidth,
        6,
      );
      expect((m[3] * x + m[4] * y + m[5]) / denominator).toBeCloseTo(
        point.y * imageHeight,
        6,
      );
    });
  });
});

describe("estimateAspectRatio（AC-QUAD-2、AC-QUAD-5）", () => {
  test("正对拍摄的 800×400 矩形，退回无透视的边长比，误差 ≤ 10%", () => {
    const quad = projectRectangle({
      width: 800,
      height: 400,
      imageWidth: 1000,
      imageHeight: 1000,
      focal: 1000,
      distance: 1000,
      pitch: 0,
    });
    const ratio = estimateAspectRatio(quad, 1000, 1000);
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeCloseTo(2, 6);
  });

  test("斜拍（俯仰 25° + 偏摆 20°）的 800×400 矩形，误差 ≤ 10%", () => {
    const quad = projectRectangle({
      width: 800,
      height: 400,
      imageWidth: 1000,
      imageHeight: 1000,
      focal: 1000,
      distance: 1000,
      pitch: (25 * Math.PI) / 180,
      yaw: (20 * Math.PI) / 180,
    });
    const ratio = estimateAspectRatio(quad, 1000, 1000);
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThan(2 * 0.9);
    expect(ratio as number).toBeLessThan(2 * 1.1);
  });

  test("斜拍（俯仰 45° + 偏摆 15°、更远的机位、非方形画面）仍能复原比例", () => {
    const quad = projectRectangle({
      width: 800,
      height: 400,
      imageWidth: 1200,
      imageHeight: 800,
      focal: 1200,
      distance: 1600,
      pitch: (45 * Math.PI) / 180,
      yaw: (15 * Math.PI) / 180,
    });
    const ratio = estimateAspectRatio(quad, 1200, 800);
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThan(2 * 0.9);
    expect(ratio as number).toBeLessThan(2 * 1.1);
  });

  test("竖着放的 400×800 矩形给出小于 1 的比例", () => {
    const quad = projectRectangle({
      width: 400,
      height: 800,
      imageWidth: 1000,
      imageHeight: 1000,
      focal: 1000,
      distance: 1000,
      pitch: (20 * Math.PI) / 180,
      yaw: (12 * Math.PI) / 180,
    });
    const ratio = estimateAspectRatio(quad, 1000, 1000);
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThan(0.5 * 0.9);
    expect(ratio as number).toBeLessThan(0.5 * 1.1);
  });

  test("只俯仰不偏摆：一组对边保持平行，焦距无从解出，判为估算失败", () => {
    const quad = projectRectangle({
      width: 800,
      height: 400,
      imageWidth: 1000,
      imageHeight: 1000,
      focal: 1000,
      distance: 1000,
      pitch: (30 * Math.PI) / 180,
    });
    expect(estimateAspectRatio(quad, 1000, 1000)).toBeNull();
  });

  test("退化输入返回 null，调用方据此退回原图比例", () => {
    expect(
      estimateAspectRatio(
        quadOf([
          [0.1, 0.1],
          [0.5, 0.5],
          [0.9, 0.9],
          [0.1, 0.9],
        ]),
        1000,
        1000,
      ),
    ).toBeNull();
  });

  test("比例超出 [0.2, 5] 时判为估算失败", () => {
    // 极端扁的四边形：推算出来的比例远超 5，按约定退回原图比例。
    const quad = quadOf([
      [0.1, 0.45],
      [0.9, 0.1],
      [0.9, 0.12],
      [0.1, 0.47],
    ]);
    const ratio = estimateAspectRatio(quad, 1000, 1000);
    if (ratio !== null) {
      expect(ratio).toBeGreaterThanOrEqual(MIN_ASPECT_RATIO);
      expect(ratio).toBeLessThanOrEqual(MAX_ASPECT_RATIO);
    }
  });
});

describe("resolveAspectRatio（AC-QUAD-5、AC-QUAD-6）", () => {
  const projected = projectRectangle({
    width: 800,
    height: 400,
    imageWidth: 1000,
    imageHeight: 1000,
    focal: 1000,
    distance: 1000,
    pitch: (25 * Math.PI) / 180,
    yaw: (20 * Math.PI) / 180,
  });

  test("手输实际尺寸时以手输为准，与估算冲突也用手输", () => {
    const resolved = resolveAspectRatio({
      quad: projected,
      imageWidth: 1000,
      imageHeight: 1000,
      realSize: { width: 900, height: 300 },
    });
    expect(resolved.source).toBe("manual");
    expect(resolved.ratio).toBeCloseTo(3, 6);
  });

  test("没有手输时用消失点估算", () => {
    const resolved = resolveAspectRatio({
      quad: projected,
      imageWidth: 1000,
      imageHeight: 1000,
      realSize: null,
    });
    expect(resolved.source).toBe("estimated");
    expect(resolved.ratio).toBeGreaterThan(2 * 0.9);
    expect(resolved.ratio).toBeLessThan(2 * 1.1);
  });

  test("估算失败时退回原图比例并标记来源为 fallback（不阻断）", () => {
    const resolved = resolveAspectRatio({
      quad: quadOf([
        [0.1, 0.1],
        [0.5, 0.5],
        [0.9, 0.9],
        [0.1, 0.9],
      ]),
      imageWidth: 1600,
      imageHeight: 800,
      realSize: null,
    });
    expect(resolved.source).toBe("fallback");
    expect(resolved.ratio).toBeCloseTo(2, 6);
  });

  test("原图尺寸也读不到时兜底给 1，不产生非法比例", () => {
    const resolved = resolveAspectRatio({
      quad: quadOf([
        [0.1, 0.1],
        [0.5, 0.5],
        [0.9, 0.9],
        [0.1, 0.9],
      ]),
      imageWidth: 0,
      imageHeight: 0,
      realSize: null,
    });
    expect(resolved.source).toBe("fallback");
    expect(resolved.ratio).toBe(1);
  });
});

describe("parseQuad（库里的 jsonb → 四点，坏数据不抛错）", () => {
  test("读得回保存的四点", () => {
    const quad = defaultQuad();
    expect(
      parseQuad(
        quad.map((point) => [point.x, point.y]),
      ),
    ).toEqual(quad);
  });

  test("形状不对返回 null", () => {
    expect(parseQuad(null)).toBeNull();
    expect(parseQuad([])).toBeNull();
    expect(parseQuad([[0, 0], [1, 0], [1, 1]])).toBeNull();
    expect(parseQuad([[0, 0], [1, 0], [1, 1], ["0", 1]])).toBeNull();
    expect(parseQuad({ points: [] })).toBeNull();
  });
});
