import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAssetStorageKey, collectionStoragePrefix, resolveStoragePath } from "./storage-key";

// `resolveStoragePath` 读 `UPLOAD_DIR`（经 `src/lib/env.ts`）；单测不依赖外部环境变量。
beforeAll(() => {
  process.env.DATABASE_URL ??= "postgresql://localhost:5432/sparkflow_test";
  process.env.AUTH_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.UPLOAD_DIR = "./data/test-uploads";
});

describe("落盘路径生成（MUST 2）", () => {
  it("路径形状是 media-assets/<collectionId>/<uuid>.<ext>", () => {
    const key = buildAssetStorageKey("collection-1", "image/png", "file-1");
    expect(key).toBe("media-assets/collection-1/file-1.png");
  });

  it("扩展名由内容判断结果决定，与原始文件名无关", () => {
    expect(buildAssetStorageKey("c1", "image/jpeg", "f1")).toBe("media-assets/c1/f1.jpg");
    expect(buildAssetStorageKey("c1", "image/webp", "f1")).toBe("media-assets/c1/f1.webp");
  });

  it("未注入 id 时生成随机文件名的同一形状", () => {
    const key = buildAssetStorageKey("collection-1", "image/png");
    expect(key).toMatch(/^media-assets\/collection-1\/[0-9a-f-]{36}\.png$/);
  });

  it("拒绝带路径分隔符或上级目录的标识", () => {
    expect(() => buildAssetStorageKey("../escape", "image/png", "f1")).toThrow();
    expect(() => buildAssetStorageKey("c1", "image/png", "a/../../b")).toThrow();
  });

  it("资源夹目录前缀用于删除整目录", () => {
    expect(collectionStoragePrefix("collection-1")).toBe("media-assets/collection-1");
  });
});

describe("storage_key 解析（越界拒绝）", () => {
  it("解析到 UPLOAD_DIR 下的绝对路径", () => {
    const resolved = resolveStoragePath("media-assets/c1/f1.png");
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(path.join("media-assets", "c1", "f1.png"))).toBe(true);
  });

  it("拒绝跳出 UPLOAD_DIR 的路径", () => {
    expect(() => resolveStoragePath("../etc/passwd")).toThrow();
    expect(() => resolveStoragePath("media-assets/../../secret.png")).toThrow();
  });
});
