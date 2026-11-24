import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAssetStorageKey, resolveStoragePath } from "./storage-key";

// `resolveStoragePath` 读 `UPLOAD_DIR`（经 `src/lib/env.ts`）；单测不依赖外部环境变量。
beforeAll(() => {
  process.env.DATABASE_URL ??= "postgresql://localhost:5432/sparkflow_test";
  process.env.AUTH_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.UPLOAD_DIR = "./data/test-uploads";
});

describe("落盘路径生成（ADR 0012 第 1 条）", () => {
  it("路径形状是 media-assets/<assetId>.<ext>：照片属于总资源库，路径里没有资源夹", () => {
    const key = buildAssetStorageKey("image/png", "asset-1");
    expect(key).toBe("media-assets/asset-1.png");
  });

  it("扩展名由内容判断结果决定，与原始文件名无关", () => {
    expect(buildAssetStorageKey("image/jpeg", "f1")).toBe("media-assets/f1.jpg");
    expect(buildAssetStorageKey("image/webp", "f1")).toBe("media-assets/f1.webp");
  });

  it("未注入 id 时生成随机文件名的同一形状", () => {
    const key = buildAssetStorageKey("image/png");
    expect(key).toMatch(/^media-assets\/[0-9a-f-]{36}\.png$/);
  });

  it("拒绝带路径分隔符或上级目录的标识", () => {
    expect(() => buildAssetStorageKey("image/png", "../escape")).toThrow();
    expect(() => buildAssetStorageKey("image/png", "a/../../b")).toThrow();
  });
});

describe("storage_key 解析（越界拒绝）", () => {
  it("解析到 UPLOAD_DIR 下的绝对路径", () => {
    const resolved = resolveStoragePath("media-assets/f1.png");
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(path.join("media-assets", "f1.png"))).toBe(true);
  });

  it("拒绝跳出 UPLOAD_DIR 的路径", () => {
    expect(() => resolveStoragePath("../etc/passwd")).toThrow();
    expect(() => resolveStoragePath("media-assets/../../secret.png")).toThrow();
  });
});
