import { describe, expect, test } from "vitest";
import { formatPublishText, parsePublishText, parseTagInput } from "./text";

/**
 * 复制文案的格式（docs/prd/08 MUST 4、AC-08-2）与可解析性（AC-09-9）。
 * 期望值直接写下「标题 + 空行 + 正文 + 空行 + #标签」的样子，而不是拿实现再算一遍。
 */

describe("复制文案的固定格式", () => {
  test("标题、正文、话题三段之间各有一个空行，话题以 # 开头、空格分隔", () => {
    expect(
      formatPublishText({
        title: "城市漫步",
        body: "第一段\n\n第二段",
        tags: ["citywalk", "周末"],
      }),
    ).toBe("城市漫步\n\n第一段\n\n第二段\n\n#citywalk #周末");
  });

  test("标签去掉用户自带的 # 前缀，重复的只留第一次", () => {
    expect(
      formatPublishText({ title: "标题", body: "正文", tags: ["#旅行", "旅行", "# "] }),
    ).toBe("标题\n\n正文\n\n#旅行");
  });

  test("空段直接省略，不留连续空行；三段都空时得到空串", () => {
    expect(formatPublishText({ title: "只有标题", body: "", tags: [] })).toBe("只有标题");
    expect(formatPublishText({ title: "", body: "只有正文", tags: [] })).toBe("只有正文");
    expect(formatPublishText({ title: "", body: "", tags: [] })).toBe("");
  });

  test("文案阶段失败（标题与正文都为空）时仍能拼出话题行", () => {
    expect(formatPublishText({ title: "", body: "", tags: ["手写"] })).toBe("#手写");
  });
});

describe("复制文案能被解析回三段（AC-09-9）", () => {
  test("三段都非空时往返一致", () => {
    const content = { title: "标题甲", body: "正文第一段\n\n正文第二段", tags: ["标签一", "标签二"] };

    expect(parsePublishText(formatPublishText(content))).toEqual({
      title: "标题甲",
      body: "正文第一段\n\n正文第二段",
      tags: ["标签一", "标签二"],
    });
  });

  test("只有标题时正文与标签为空", () => {
    expect(parsePublishText(formatPublishText({ title: "标题乙", body: "", tags: [] }))).toEqual({
      title: "标题乙",
      body: "",
      tags: [],
    });
  });

  test("正文里带空行不会被当成标题与正文的分界", () => {
    const parsed = parsePublishText("标题\n\n上\n\n中\n\n下\n\n#a #b");
    expect(parsed.title).toBe("标题");
    expect(parsed.body).toBe("上\n\n中\n\n下");
    expect(parsed.tags).toEqual(["a", "b"]);
  });

  test("空文本解析成三个空值，不抛错", () => {
    expect(parsePublishText("")).toEqual({ title: "", body: "", tags: [] });
  });
});

describe("标签输入框的解析", () => {
  test("逗号、中文逗号与换行都是分隔符，去 # 前缀与重复项", () => {
    expect(parseTagInput("#旅行, 美食，\n#旅行\n")).toEqual(["旅行", "美食"]);
  });

  test("只有分隔符时得到空数组", () => {
    expect(parseTagInput(" , ，\n ")).toEqual([]);
  });
});
