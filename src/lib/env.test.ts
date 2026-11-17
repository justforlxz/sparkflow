import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const SECRET = "0123456789abcdef0123456789abcdef";
const base = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/db",
  AUTH_SECRET: SECRET,
};

describe("parseEnv", () => {
  it("缺少 DATABASE_URL 时抛出并指出变量名", () => {
    expect(() => parseEnv({ AUTH_SECRET: SECRET })).toThrowError(/DATABASE_URL/);
  });

  it("缺少 AUTH_SECRET 时抛出并指出变量名", () => {
    expect(() => parseEnv({ DATABASE_URL: base.DATABASE_URL })).toThrowError(/AUTH_SECRET/);
  });

  it("AUTH_SECRET 短于 32 个字符时报错", () => {
    expect(() =>
      parseEnv({ DATABASE_URL: base.DATABASE_URL, AUTH_SECRET: "too-short" }),
    ).toThrowError(/AUTH_SECRET/);
  });

  it("补齐默认值", () => {
    expect(parseEnv(base)).toMatchObject({
      NODE_ENV: "development",
      DATABASE_URL: base.DATABASE_URL,
      UPLOAD_DIR: "./data/uploads",
      MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
      GENERATION_ADAPTER: "real",
    });
  });

  it("MAX_UPLOAD_BYTES 接受字符串并转成数字", () => {
    expect(parseEnv({ ...base, MAX_UPLOAD_BYTES: "2048" }).MAX_UPLOAD_BYTES).toBe(2048);
  });

  it("GENERATION_ADAPTER 只接受 real / mock", () => {
    expect(() => parseEnv({ ...base, GENERATION_ADAPTER: "fake" })).toThrowError(
      /GENERATION_ADAPTER/,
    );
    expect(parseEnv({ ...base, GENERATION_ADAPTER: "mock" }).GENERATION_ADAPTER).toBe("mock");
  });
});
