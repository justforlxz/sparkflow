import { describe, expect, it } from "vitest";
import { collectionFieldsSchema, listCollectionsQuerySchema, thumbnailWidthSchema } from "./schema";

describe("资源夹字段（multipart 与 JSON 共用）", () => {
  it("只给名称时其余来源字段归一成 null", () => {
    expect(collectionFieldsSchema.parse({ name: "秋季穿搭" })).toEqual({
      name: "秋季穿搭",
      platform: null,
      sourceUrl: null,
      sourceTitle: null,
      sourceBody: null,
    });
  });

  it("空串与纯空白当作未填写", () => {
    const parsed = collectionFieldsSchema.parse({
      name: "  秋季穿搭  ",
      platform: "  ",
      sourceUrl: "",
      sourceTitle: "秋季穿搭 3 套",
      sourceBody: "  ",
    });
    expect(parsed).toEqual({
      name: "秋季穿搭",
      platform: null,
      sourceUrl: null,
      sourceTitle: "秋季穿搭 3 套",
      sourceBody: null,
    });
  });

  it("缺少名称时提示填写名称", () => {
    const result = collectionFieldsSchema.safeParse({ platform: "小红书" });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues[0]?.message).toBe("请填写资源夹名称");
  });

  it("名称超长被拒绝", () => {
    expect(collectionFieldsSchema.safeParse({ name: "长".repeat(101) }).success).toBe(false);
  });
});

describe("列表查询参数", () => {
  it("缺省时用默认分页", () => {
    expect(listCollectionsQuerySchema.parse({})).toEqual({
      q: undefined,
      status: undefined,
      page: 1,
      pageSize: 20,
    });
  });

  it("搜索词与状态筛选原样带上", () => {
    expect(
      listCollectionsQuerySchema.parse({ q: " 穿搭 ", status: "has_results", page: "2", pageSize: "10" }),
    ).toEqual({ q: "穿搭", status: "has_results", page: 2, pageSize: 10 });
  });

  it("空串当作没有筛选条件", () => {
    expect(listCollectionsQuerySchema.parse({ q: "", status: "" })).toMatchObject({
      q: undefined,
      status: undefined,
      page: 1,
    });
  });

  it("未登记的状态值被拒绝", () => {
    expect(listCollectionsQuerySchema.safeParse({ status: "archived" }).success).toBe(false);
  });

  it("每页数量有上限", () => {
    expect(listCollectionsQuerySchema.safeParse({ pageSize: "500" }).success).toBe(false);
  });
});

describe("缩略图宽度参数", () => {
  it("没有 w 时不缩放", () => {
    expect(thumbnailWidthSchema.parse(undefined)).toBeUndefined();
    expect(thumbnailWidthSchema.parse("")).toBeUndefined();
  });

  it("超过上限的宽度被拒绝", () => {
    expect(thumbnailWidthSchema.safeParse("4000").success).toBe(false);
  });
});
