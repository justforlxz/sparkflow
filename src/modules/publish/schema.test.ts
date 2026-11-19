import { describe, expect, it } from "vitest";
import { listPublishRecordsQuerySchema } from "./schema";

/**
 * 发布记录列表查询参数（`/published` 页面与两个列表接口共用，docs/prd/08「数据与接口」）。
 *
 * `/published` 的「非法参数退回默认」依赖这里的判定：`safeParse` 失败时页面才回退到
 * 第 1 页、不筛选（AC-FIX-1、AC-FIX-2）。所以这里把「哪些值算不合法」逐条固定住。
 */
describe("发布记录列表查询参数", () => {
  it("缺省时用默认分页、不筛选", () => {
    expect(listPublishRecordsQuerySchema.parse({})).toEqual({
      collectionId: undefined,
      page: 1,
      pageSize: 20,
    });
  });

  it("空串当作未填写", () => {
    expect(listPublishRecordsQuerySchema.parse({ collectionId: "", page: "" })).toEqual({
      collectionId: undefined,
      page: 1,
      pageSize: 20,
    });
  });

  it("合法资源夹 id 与数字页码原样通过", () => {
    const collectionId = "4581a7d0-10a9-4820-8f70-7f6147325628";
    expect(listPublishRecordsQuerySchema.parse({ collectionId, page: "3", pageSize: "10" })).toEqual({
      collectionId,
      page: 3,
      pageSize: 10,
    });
  });

  it("资源夹 id 不是 UUID 时判定为参数不合法", () => {
    // 资源夹主键是 `@default(uuid())`，格式不对的 id 一定查不到资源夹。
    expect(listPublishRecordsQuerySchema.safeParse({ collectionId: "not-a-uuid" }).success).toBe(
      false,
    );
  });

  it("页码是 0、负数或非数字时判定为参数不合法", () => {
    for (const page of ["0", "-1", "abc"]) {
      expect(listPublishRecordsQuerySchema.safeParse({ page }).success, `page=${page}`).toBe(false);
    }
  });

  it("超出总数的页码仍是合法参数，由分页规则给出空列表", () => {
    // 越界不是参数错误：分页是原始 skip/take，跳过所有行就是空列表（AC-FIX-2）。
    expect(listPublishRecordsQuerySchema.parse({ page: "99999" }).page).toBe(99999);
  });
});
