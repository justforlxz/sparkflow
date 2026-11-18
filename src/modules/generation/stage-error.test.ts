import { describe, expect, it } from "vitest";
import { MAX_ERROR_MESSAGE_LENGTH, STAGE_ERROR_CODES } from "./constants";
import { stageErrorFrom, stageErrorRecord } from "./stage-error";
import { StageError } from "./types";

const AT = new Date("2026-01-02T03:04:05.000Z");

describe("阶段失败的记录（MUST 5）", () => {
  it("保留处理器给出的业务码与发生时间", () => {
    expect(stageErrorFrom(new StageError("COPY_FORMAT", "返回的不是 JSON"), AT)).toEqual({
      code: "COPY_FORMAT",
      message: "返回的不是 JSON",
      at: AT.toISOString(),
    });
  });

  it("普通异常统一记成 STAGE_FAILED", () => {
    expect(stageErrorFrom(new Error("连接被重置"), AT).code).toBe(STAGE_ERROR_CODES.stageFailed);
  });

  it("非 Error 的抛出物也有可读消息", () => {
    expect(stageErrorFrom("上游返回了字符串", AT).message).toBe("上游返回了字符串");
    expect(stageErrorFrom(undefined, AT).message.length).toBeGreaterThan(0);
  });

  it("消息里的密钥与 Authorization 形态被脱敏（AC-05-8）", () => {
    const record = stageErrorFrom(
      new Error("调用失败 sk-abcd1234efgh，Authorization: Bearer abc123def456"),
      AT,
    );
    expect(record.message).not.toContain("sk-abcd1234efgh");
    expect(record.message).not.toContain("abc123def456");
    expect(record.message).toContain("[REDACTED]");
  });

  it("超长消息按上限截断", () => {
    const record = stageErrorRecord(STAGE_ERROR_CODES.timeout, "长".repeat(5000), AT);
    expect(record.message).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
    expect(record.code).toBe(STAGE_ERROR_CODES.timeout);
  });

  it("空消息退回到可读文案，不写空字符串", () => {
    expect(stageErrorRecord(STAGE_ERROR_CODES.serverRestarted, "   ", AT).message.length).toBeGreaterThan(0);
  });
});
