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
      throw new Error(
        "打不开 postgresql://crp:crp@db:5432/crp\n    at handler (src/app/api/x/route.ts:12:7)",
      );
    });

    const response = await handler(new Request("http://localhost/api/x"), undefined);
    expect(response.status).toBe(500);
    const body = await readBody(response);
    expect(body).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "服务器内部错误" },
    });
    // AC-B-3：响应体里不能出现连接串，也不能出现堆栈。
    const text = JSON.stringify(body);
    expect(text).not.toContain("postgresql://");
    expect(text).not.toContain("at handler");
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

  /** 把某个异常交给 route() 翻译，返回状态码与响应体（日志用 spy 吞掉）。 */
  async function translate(thrown: unknown) {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await route(() => {
      throw thrown;
    })(new Request("http://localhost/api/x"), undefined);
    const body = await readBody(response);
    spy.mockRestore();
    return { status: response.status, body, text: JSON.stringify(body) };
  }

  it("pg 静默断开连接时只给一句消息、没有错误码，仍映射成 503（AC-B-2）", async () => {
    const { status, body } = await translate(new Error("Connection terminated unexpectedly"));

    expect(status).toBe(503);
    expect(body).toEqual({
      ok: false,
      error: { code: "UPSTREAM_FAILED", message: "数据库不可达，请稍后重试" },
    });
  });

  it("驱动层套接字错误码映射成 503（AC-B-2）", async () => {
    const { status, body } = await translate(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
    );

    expect(status).toBe(503);
    expect(body).toEqual({
      ok: false,
      error: { code: "UPSTREAM_FAILED", message: "数据库不可达，请稍后重试" },
    });
  });

  it("P2010 里包着服务端停机 SQLSTATE 时映射成 503（实测形状 57P01）", async () => {
    // 实测：数据库容器停止时，连接中途被 terminate，Prisma 报 P2010，
    // 真正的判据在 meta.driverAdapterError.cause 的 originalCode 上。
    const error = Object.assign(new Error("Invalid `prisma.$queryRaw()` invocation"), {
      code: "P2010",
      meta: {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: {
            originalCode: "57P01",
            originalMessage: "terminating connection due to administrator command",
            kind: "postgres",
            code: "57P01",
            severity: "FATAL",
          },
        },
      },
    });

    const { status, body } = await translate(error);

    expect(status).toBe(503);
    expect(body).toEqual({
      ok: false,
      error: { code: "UPSTREAM_FAILED", message: "数据库不可达，请稍后重试" },
    });
  });

  it("P2010 里是普通 SQL 错误时仍是 500 INTERNAL，不误判成上游不可用", async () => {
    const error = Object.assign(new Error("Invalid `prisma.$queryRaw()` invocation"), {
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "42P01", kind: "postgres" } } },
    });

    const { status, body } = await translate(error);

    expect(status).toBe(500);
    expect(body).toEqual({ ok: false, error: { code: "INTERNAL", message: "服务器内部错误" } });
  });

  it("readJson 解析失败时抛 VALIDATION_FAILED", async () => {
    const request = new Request("http://localhost/api/features/x", {
      method: "PATCH",
      body: "not-json",
    });
    await expect(readJson(request)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
