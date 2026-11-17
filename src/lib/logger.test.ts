import { describe, expect, it } from "vitest";
import { REDACTED, formatLogLine, redactText, redactValue } from "./logger";

describe("脱敏（AC-S1-10）", () => {
  it("敏感字段名整体替换", () => {
    const redacted = redactValue({
      apiKey: "sk-live-abcdef123456",
      authorization: "Bearer abc.def.ghi",
      cookie: "session=1",
      password: "hunter2",
      model: "image-model",
    }) as Record<string, unknown>;

    expect(redacted.apiKey).toBe(REDACTED);
    expect(redacted.authorization).toBe(REDACTED);
    expect(redacted.cookie).toBe(REDACTED);
    expect(redacted.password).toBe(REDACTED);
    expect(redacted.model).toBe("image-model");
  });

  it("文本里的 sk- 与 Bearer 形态被替换", () => {
    expect(redactText("调用失败：sk-proj-9f8e7d6c5b4a 无效")).toBe(`调用失败：${REDACTED} 无效`);
    expect(redactText("header Authorization: Bearer eyJhbGciOi.payload.sig")).toBe(
      `header Authorization: ${REDACTED}`,
    );
  });

  it("嵌套结构里也脱敏", () => {
    const redacted = redactValue({
      request: { headers: { authorization: "Bearer token-value" } },
      list: [{ token: "abc" }],
    }) as { request: { headers: { authorization: string } }; list: { token: string }[] };

    expect(redacted.request.headers.authorization).toBe(REDACTED);
    expect(redacted.list[0]?.token).toBe(REDACTED);
  });

  it("日志行是 JSON，且不含原始凭据", () => {
    const line = formatLogLine(
      "error",
      "请求失败 sk-live-abcdef",
      { apiKey: "sk-live-abcdef", url: "https://example.com/models" },
      "2026-11-17T00:00:00.000Z",
    );

    expect(line).not.toContain("sk-live-abcdef");

    const record = JSON.parse(line) as {
      time: string;
      level: string;
      message: string;
      meta: { apiKey: string };
    };
    expect(record.time).toBe("2026-11-17T00:00:00.000Z");
    expect(record.level).toBe("error");
    expect(record.message).toContain(REDACTED);
    expect(record.meta.apiKey).toBe(REDACTED);
  });
});
