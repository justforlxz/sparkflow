import { expect, test } from "@playwright/test";
import { ensureAccount } from "./support/auth";

test.beforeEach(async ({ request }) => {
  await ensureAccount(request);
});

interface FeatureListBody {
  ok: boolean;
  data: {
    features: Array<{
      key: string;
      implemented: boolean;
      enabled: boolean;
      active: boolean;
      disabledMessage: string;
    }>;
  };
}

test("AC-S1-4 GET /api/features 返回两项且都未实现", async ({ request }) => {
  const response = await request.get("/api/features");
  expect(response.status()).toBe(200);

  const body = (await response.json()) as FeatureListBody;
  expect(body.ok).toBe(true);
  expect(body.data.features.map((feature) => feature.key)).toEqual([
    "image-to-image",
    "share-to-xiaohongshu",
  ]);
  for (const feature of body.data.features) {
    expect(feature.implemented).toBe(false);
    expect(feature.active).toBe(false);
    expect(feature.disabledMessage.length).toBeGreaterThan(0);
  }
});

test("AC-S1-4 开启未实现项返回 FEATURE_NOT_IMPLEMENTED 且库值不变", async ({ request }) => {
  const before = (await (await request.get("/api/features")).json()) as FeatureListBody;

  for (const key of ["image-to-image", "share-to-xiaohongshu"]) {
    const response = await request.patch(`/api/features/${key}`, { data: { enabled: true } });
    expect(response.status()).toBe(400);

    const body = (await response.json()) as {
      error: { code: string; details?: { code: string; feature: string } };
    };
    expect(body.error.details?.code).toBe("FEATURE_NOT_IMPLEMENTED");
    expect(body.error.details?.feature).toBe(key);
  }

  const after = (await (await request.get("/api/features")).json()) as FeatureListBody;
  expect(after.data.features).toEqual(before.data.features);
});

test("AC-S1-4 未注册的开关返回 NOT_FOUND", async ({ request }) => {
  const response = await request.patch("/api/features/not-registered", { data: { enabled: true } });
  expect(response.status()).toBe(404);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("NOT_FOUND");
});
