import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError } from "./errors";
import { okResponse, readJson, route } from "./http";

async function readBody(response: Response) {
  return (await response.json()) as {
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
}

describe("响应信封", () => {
  it("成功响应是 { ok: true, data }", async () => {
    const response = okResponse({ status: "ok" }, 201);
    expect(response.status).toBe(201);
    expect(await readBody(response)).toEqual({ ok: true, data: { status: "ok" } });
  });

  it("AppError 使用它自己的状态码与错误码", async () => {
    const handler = route(() => {
      throw AppError.notFound("接口不存在");
    });

    const response = await handler(new Request("http://localhost/api/nope"), undefined);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await readBody(response)).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "接口不存在" },
    });
  });

  it("AppError 可以覆盖状态码并携带业务子码", async () => {
    const handler = route(() => {
      throw new AppError("CONFLICT", "该功能未启用", {
        details: { code: "FEATURE_DISABLED", feature: "image-to-image" },
      });
    });

    const response = await handler(new Request("http://localhost/api/features/x"), undefined);
    expect(response.status).toBe(409);
    expect((await readBody(response)).error).toEqual({
      code: "CONFLICT",
      message: "该功能未启用",
      details: { code: "FEATURE_DISABLED", feature: "image-to-image" },
    });
  });

  it("ZodError 转成 VALIDATION_FAILED 400", async () => {
    const handler = route(() => {
      z.object({ enabled: z.boolean() }).parse({});
      return okResponse(null);
    });

    const response = await handler(new Request("http://localhost/api/features/x"), undefined);
    expect(response.status).toBe(400);
    const body = await readBody(response);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details?.issues).toBeInstanceOf(Array);
  });

  it("未知异常转成 INTERNAL 500，不把原始信息暴露给客户端", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = route(() => {
      throw new Error("数据库密码是 hunter2");
    });

    const response = await handler(new Request("http://localhost/api/x"), undefined);
    expect(response.status).toBe(500);
    expect(await readBody(response)).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "服务器内部错误" },
    });
    spy.mockRestore();
  });

  it("数据库连接类错误映射成 503 UPSTREAM_FAILED，且不泄露原始信息", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = route(() => {
      throw Object.assign(new Error("Can't reach database server at db:5432/password=secret"), {
        errorCode: "P1001",
      });
    });

    const response = await handler(new Request("http://localhost/api/auth/login"), undefined);
    expect(response.status).toBe(503);
    expect(await readBody(response)).toEqual({
      ok: false,
      error: { code: "UPSTREAM_FAILED", message: "数据库不可达，请稍后重试" },
    });
    spy.mockRestore();
  });

  it("readJson 解析失败时抛 VALIDATION_FAILED", async () => {
    const request = new Request("http://localhost/api/features/x", {
      method: "PATCH",
      body: "not-json",
    });
    await expect(readJson(request)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
