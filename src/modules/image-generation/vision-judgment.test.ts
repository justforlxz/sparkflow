import { describe, expect, it } from "vitest";
import { EXTRACTION_CATEGORIES, SELECTABLE_CATEGORIES } from "@/modules/extraction/categories";
import {
  EXTRACTION_EDGE_STEP,
  EXTRACTION_LONG_EDGE,
  MIN_EXTRACTION_EDGE,
  buildExistencePrompt,
  deriveExtractionSize,
  parseExistenceVerdict,
} from "./vision-judgment";

/** 两段式判定的纯逻辑（ADR 0011 第 2 / 4 条、AC-LIB-11、AC-LIB-13、AC-LIB-16）。 */
describe("判定提示词", () => {
  it("用类别的 presenceQuestion 提问，并要求固定的两个词回答", () => {
    const prompt = buildExistencePrompt("graphic");
    expect(prompt).toContain("这张照片里的桌垫上是否印有图案");
    expect(prompt).toContain("只回答「存在」或「不存在」");
  });

  it("三类问题的问法各不相同，都非空（MUST 2b-1）", () => {
    const questions = SELECTABLE_CATEGORIES.map((entry) => entry.presenceQuestion);
    expect(questions).toHaveLength(3);
    for (const question of questions) expect(question.trim().length).toBeGreaterThan(0);
    expect(new Set(questions).size).toBe(3);
  });

  it("判定提示词里没有产物形态的措辞（MUST 2b-1、AC-LIB-16 的回归锁）", () => {
    // 这些词来自 `description`，写的是产物形态。拿它们问原图，斜拍照片一律判「不存在」。
    const productFormWording = ["边缘可平铺", "背景干净", "不要透视畸变", "正面俯视", "画面内纹理均匀"];

    for (const category of SELECTABLE_CATEGORIES) {
      const prompt = buildExistencePrompt(category.value);
      // 整句 description 都不能出现在判定提示词里 —— 这是 MUST NOT 共用一句话的直接断言。
      expect(prompt, `${category.value} 的判定提示词不应包含 description`).not.toContain(
        category.description,
      );
      for (const wording of productFormWording) {
        expect(prompt, `${category.value} 的判定提示词不应包含「${wording}」`).not.toContain(wording);
      }
      // 反过来：`description` 里的产物形态措辞也都不该被拆开混进来。
      expect(prompt).toContain(category.presenceQuestion);
    }
  });

  it("描述与问法确实是两句话，不是同一句（MUST NOT 共用一句话）", () => {
    for (const category of EXTRACTION_CATEGORIES) {
      expect(category.presenceQuestion).not.toBe(category.description);
      expect(category.presenceQuestion).not.toContain(category.description);
    }
  });

  it("认不出的 key 拼出同形状的问题，不编造描述", () => {
    const prompt = buildExistencePrompt("legacy-key");
    expect(prompt).toContain("「legacy-key」");
    expect(prompt).toContain("只回答「存在」或「不存在」");
  });
});

describe("判定回复解析", () => {
  it("「不存在」优先于「存在」：前者包含后者，顺序反了会读成存在", () => {
    expect(parseExistenceVerdict("不存在：画面里没有印刷图案")).toEqual({
      exists: false,
      reason: "不存在：画面里没有印刷图案",
    });
    expect(parseExistenceVerdict("存在：图案位于画面中央")).toEqual({
      exists: true,
      reason: "存在：图案位于画面中央",
    });
  });

  it("归一化空白：多行回复压成一行，便于展示与入库", () => {
    expect(parseExistenceVerdict("  不存在：\n  画面里没有  \n 目标 ")).toEqual({
      exists: false,
      reason: "不存在： 画面里没有 目标",
    });
  });

  it("两个词都没出现：返回 null，由调用方按失败处理，不替模型下结论", () => {
    expect(parseExistenceVerdict("看起来像是有的")).toBeNull();
    expect(parseExistenceVerdict("   ")).toBeNull();
  });
});

/** 从 `"WxH"` 拆出两个整数。 */
function parseSize(size: string): { width: number; height: number } {
  const [width, height] = size.split("x").map(Number);
  return { width: width as number, height: height as number };
}

/**
 * 上游三条硬约束（MUST 2d-1、AC-LIB-17）：
 * 宽高都是 32 的倍数、都落在 [512,4096]、长宽比 ≤ 3:1。
 * 违反任意一条，真实上游直接 400 `invalid size`。
 */
function expectUpstreamAcceptable(size: string): void {
  const { width, height } = parseSize(size);
  expect(width % EXTRACTION_EDGE_STEP, `${size} 的宽应是 32 的倍数`).toBe(0);
  expect(height % EXTRACTION_EDGE_STEP, `${size} 的高应是 32 的倍数`).toBe(0);
  expect(width, `${size} 的宽应 ≥ 512`).toBeGreaterThanOrEqual(MIN_EXTRACTION_EDGE);
  expect(height, `${size} 的高应 ≥ 512`).toBeGreaterThanOrEqual(MIN_EXTRACTION_EDGE);
  expect(width, `${size} 的宽应 ≤ 4096`).toBeLessThanOrEqual(4096);
  expect(height, `${size} 的高应 ≤ 4096`).toBeLessThanOrEqual(4096);
  expect(Math.max(width, height) / Math.min(width, height), `${size} 的比例应 ≤ 3:1`)
    .toBeLessThanOrEqual(3);
}

describe("输出尺寸跟随原图长宽比（AC-LIB-13）", () => {
  it("长边固定 1536，短边按比例向下取到 32 的倍数", () => {
    expect(deriveExtractionSize(900, 600)).toBe("1536x1024");
    expect(deriveExtractionSize(600, 900)).toBe("1024x1536");
    expect(deriveExtractionSize(1536, 1536)).toBe("1536x1536");
    expect(deriveExtractionSize(3000, 1000)).toBe("1536x512");
  });

  it("尺寸不合法时退回正方形，不把「读不到尺寸」变成上游参数错误", () => {
    expect(deriveExtractionSize(0, 0)).toBe("1536x1536");
    expect(deriveExtractionSize(Number.NaN, 600)).toBe("1536x1536");
    expect(deriveExtractionSize(-10, 600)).toBe("1536x1536");
  });
});

describe("AC-LIB-17 推导结果满足上游三条硬约束（32 倍数 / [512,4096] / ≤3:1）", () => {
  it("契约给的三个边界例", () => {
    expect(deriveExtractionSize(4000, 1333)).toBe("1536x512");
    expect(deriveExtractionSize(1000, 3000)).toBe("512x1536");
    expect(deriveExtractionSize(1200, 1200)).toBe("1536x1536");
  });

  it("功能检测报的六档失败样本全部满足三条约束", () => {
    // 这六档在四舍五入实现下分别产出 1536x1024 / 1536x512 / 1536x1021 / 1536x1072 /
    // 1536x384 / 1536x461，其中四档被真实上游 400 拒绝。
    const samples: Array<[number, number]> = [
      [1440, 960],
      [4000, 1333],
      [1500, 997],
      [1440, 1005],
      [4000, 1000],
      [4000, 1200],
    ];
    for (const [width, height] of samples) {
      expectUpstreamAcceptable(deriveExtractionSize(width, height));
    }
  });

  it("任意长宽比都满足三条约束（含极端比例与竖图）", () => {
    const samples: Array<[number, number]> = [
      [1, 1],
      [3, 2],
      [4, 3],
      [16, 9],
      [2, 3],
      [9, 16],
      [100_000, 1],
      [1, 100_000],
      [4000, 4000],
      [1920, 1080],
      [1080, 1920],
      [3000, 4000],
      [3333, 777],
    ];
    for (const [width, height] of samples) {
      expectUpstreamAcceptable(deriveExtractionSize(width, height));
    }
  });

  it("比例不超过 3:1：短边被夹到 512，长边仍是 1536", () => {
    // 4000×1000 是 4:1，按比例算短边 384，必须抬到 512 才满足 ≤3:1。
    expect(deriveExtractionSize(4000, 1000)).toBe("1536x512");
    expect(deriveExtractionSize(1000, 4000)).toBe("512x1536");
  });

  it("短边向下取整而不是四舍五入：1500×997 不会得到 1024", () => {
    // 997/1500×1536 = 1020.9，四舍五入到 1021 不是 32 的倍数；向下取到 992。
    expect(deriveExtractionSize(1500, 997)).toBe("1536x992");
  });
});
