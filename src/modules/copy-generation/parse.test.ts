import { describe, expect, it } from "vitest";
import { COPY_ERROR_CODES } from "./constants";
import { normalizeTags, parseCopyContent } from "./parse";

const VALID = {
  title: "今天的早餐",
  body: "第一段正文。\n\n第二段正文。",
  tags: ["早餐", "日常"],
};

function raw(payload: unknown): string {
  return JSON.stringify(payload);
}

describe("文案解析（AC-06-1 ~ AC-06-4）", () => {
  it("AC-06-1 正常 JSON 返回三个字段，tags 不含 # 且已去重", () => {
    const copy = parseCopyContent(
      raw({ ...VALID, tags: ["#早餐", "日常", "#早餐", "家常"] }),
    );

    expect(copy.title).toBe("今天的早餐");
    expect(copy.body).toBe("第一段正文。\n\n第二段正文。");
    expect(copy.tags).toEqual(["早餐", "日常", "家常"]);
  });

  it("AC-06-2 包在 ```json 围栏里也能解析（语言标记可省略）", () => {
    const fenced = ["```json", raw(VALID), "```"].join("\n");
    expect(parseCopyContent(fenced)).toEqual(VALID);

    const plainFence = ["```", raw(VALID), "```"].join("\n");
    expect(parseCopyContent(plainFence)).toEqual(VALID);
  });

  it("AC-06-3 返回非 JSON 时抛 COPY_FORMAT，不产出任何字段", () => {
    expect(() => parseCopyContent("这是一段自由文本，不是 JSON")).toThrowError(
      expect.objectContaining({ code: COPY_ERROR_CODES.format }),
    );
  });

  it("AC-06-3 围栏里也不是 JSON 时同样记 COPY_FORMAT", () => {
    const fenced = ["```json", "{ title: 没有引号 }", "```"].join("\n");
    expect(() => parseCopyContent(fenced)).toThrowError(
      expect.objectContaining({ code: COPY_ERROR_CODES.format }),
    );
  });

  it("AC-06-4 tags 给成 `#a #b` 字符串时解析成数组", () => {
    const copy = parseCopyContent(raw({ ...VALID, tags: "  #早餐 #日常 #早餐 " }));
    expect(copy.tags).toEqual(["早餐", "日常"]);
  });

  it("tags 用逗号分隔也认，空项与重复项被丢掉", () => {
    expect(normalizeTags("a, b，，a、c")).toEqual(["a", "b", "c"]);
  });

  it("tags 既不是数组也不是字符串时按格式异常处理", () => {
    expect(() => normalizeTags(42)).toThrowError(
      expect.objectContaining({ code: COPY_ERROR_CODES.format }),
    );
  });

  it("顶层不是对象时按格式异常处理", () => {
    expect(() => parseCopyContent("[1,2,3]")).toThrowError(
      expect.objectContaining({ code: COPY_ERROR_CODES.format }),
    );
  });
});

describe("文案阈值（AC-07-7、AC-07-8）", () => {
  it("AC-07-7 title 为空串时判定失败（COPY_EMPTY），不返回部分结果", () => {
    expect(() => parseCopyContent(raw({ title: "", body: "x", tags: [] }))).toThrowError(
      expect.objectContaining({ code: COPY_ERROR_CODES.empty }),
    );
  });

  it("AC-07-7 title 只有空白也算空", () => {
    expect(() => parseCopyContent(raw({ title: "   ", body: "x", tags: ["a"] }))).toThrowError(
      expect.objectContaining({ code: COPY_ERROR_CODES.empty }),
    );
  });

  it("AC-07-8 返回 20 个标签时只保留前 10 个，顺序不变", () => {
    const tags = Array.from({ length: 20 }, (_, index) => `标签${index + 1}`);
    const copy = parseCopyContent(raw({ ...VALID, tags }));

    expect(copy.tags).toHaveLength(10);
    expect(copy.tags).toEqual(tags.slice(0, 10));
  });
});

describe("文案清洗", () => {
  it("标题去空白，正文压缩连续空行到最多一个空行", () => {
    const copy = parseCopyContent(
      raw({
        title: "  带空白的标题  ",
        body: "第一段\n\n\n\n\n第二段\n\n",
        tags: [],
      }),
    );

    expect(copy.title).toBe("带空白的标题");
    expect(copy.body).toBe("第一段\n\n第二段");
  });

  it("标题超过 40 字时截断到 40 字", () => {
    const title = "一".repeat(60);
    const copy = parseCopyContent(raw({ title, body: "", tags: [] }));

    expect(Array.from(copy.title)).toHaveLength(40);
  });

  it("缺 tags 字段时返回空数组，不报错", () => {
    const copy = parseCopyContent(raw({ title: "标题", body: "正文" }));
    expect(copy.tags).toEqual([]);
  });
});
