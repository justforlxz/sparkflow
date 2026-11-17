import { readdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("AC-S1-2 健康检查返回版本与结构版本（等于已应用迁移条数）", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);

  const body = (await response.json()) as {
    ok: boolean;
    data: { status: string; version: string; schemaVersion: number };
  };

  const migrationCount = readdirSync("prisma/migrations", { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  ).length;

  expect(body.ok).toBe(true);
  expect(body.data.status).toBe("ok");
  expect(body.data.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(body.data.schemaVersion).toBe(migrationCount);
});
