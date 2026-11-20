import { describe, expect, it } from "vitest";
import {
  collectionEditAssetsSchema,
  collectionFieldsSchema,
  listCollectionsQuerySchema,
  thumbnailWidthSchema,
} from "./schema";

describe("资源夹字段（multipart 与 JSON 共用）", () => {
  it("只给名称时其余来源字段归一成 null", () => {
    expect(collectionFieldsSchema.parse({ name: "秋季穿搭" })).toEqual({
      name: "秋季穿搭",
      platform: null,
      sourceUrl: null,
      sourceTitle: null,
      sourceBody: null,
      extractTarget: null,
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
      extractTarget: null,
    });
  });

  it("提取目标可以填写，首尾空白去掉，空值归一成 null", () => {
    expect(collectionFieldsSchema.parse({ name: "秋季穿搭", extractTarget: "  桌垫的织物纹理 " }))
      .toMatchObject({ extractTarget: "桌垫的织物纹理" });
    expect(collectionFieldsSchema.parse({ name: "秋季穿搭", extractTarget: "  " })).toMatchObject({
      extractTarget: null,
    });
  });

  it("提取目标超长被拒绝", () => {
    expect(collectionFieldsSchema.safeParse({ name: "秋季穿搭", extractTarget: "长".repeat(201) }).success).toBe(false);
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

describe("整组保存的图片清单（POST /api/collections/[id]/save）", () => {
  it("保留、移除、新增三种项按原顺序解析", () => {
    const parsed = collectionEditAssetsSchema.parse([
      { kind: "keep", assetId: "a" },
      { kind: "remove", assetId: "b" },
      { kind: "add", tempKey: "pending-1" },
    ]);
    expect(parsed).toEqual([
      { kind: "keep", assetId: "a" },
      { kind: "remove", assetId: "b" },
      { kind: "add", tempKey: "pending-1" },
    ]);
  });

  it("空清单也算合法输入，交给服务端按「至少 1 张」判据拒绝", () => {
    expect(collectionEditAssetsSchema.parse([])).toEqual([]);
  });

  it("未登记的 kind 被拒绝", () => {
    expect(collectionEditAssetsSchema.safeParse([{ kind: "replace", assetId: "a" }]).success).toBe(
      false,
    );
  });

  it("keep / remove 缺少图片标识被拒绝", () => {
    expect(collectionEditAssetsSchema.safeParse([{ kind: "keep", assetId: "" }]).success).toBe(false);
    expect(collectionEditAssetsSchema.safeParse([{ kind: "remove" }]).success).toBe(false);
  });

  it("add 缺少上传文件标识被拒绝", () => {
    expect(collectionEditAssetsSchema.safeParse([{ kind: "add", tempKey: "" }]).success).toBe(false);
    expect(collectionEditAssetsSchema.safeParse([{ kind: "add" }]).success).toBe(false);
  });

  it("不是数组的输入被拒绝", () => {
    expect(collectionEditAssetsSchema.safeParse({ kind: "keep", assetId: "a" }).success).toBe(false);
  });
});
