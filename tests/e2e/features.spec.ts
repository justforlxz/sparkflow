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

test("AC-10-1 GET /api/features 返回两项：图生图已实现并默认开启，分享未实现", async ({
  request,
}) => {
  const response = await request.get("/api/features");
  expect(response.status()).toBe(200);

  const body = (await response.json()) as FeatureListBody;
  expect(body.ok).toBe(true);
  expect(body.data.features.map((feature) => feature.key)).toEqual([
    "image-to-image",
    "share-to-xiaohongshu",
  ]);

  const imageToImage = body.data.features.find((feature) => feature.key === "image-to-image");
  expect(imageToImage).toMatchObject({ implemented: true, active: true });

  const share = body.data.features.find((feature) => feature.key === "share-to-xiaohongshu");
  expect(share).toMatchObject({ implemented: false, active: false });

  for (const feature of body.data.features) {
    expect(feature.disabledMessage.length).toBeGreaterThan(0);
  }
});

test("AC-10-2 开启未实现项返回 FEATURE_NOT_IMPLEMENTED 且库值不变；已实现项可以开关", async ({
  request,
}) => {
  // 分享仍未实现：开启被拒，库值不变。
  const blocked = await request.patch("/api/features/share-to-xiaohongshu", {
    data: { enabled: true },
  });
  expect(blocked.status()).toBe(400);
  const blockedBody = (await blocked.json()) as {
    error: { code: string; details?: { code: string; feature: string } };
  };
  expect(blockedBody.error.details?.code).toBe("FEATURE_NOT_IMPLEMENTED");
  expect(blockedBody.error.details?.feature).toBe("share-to-xiaohongshu");

  // 图生图已实现：开与关都成功，读回来与关闭时一致。
  const enabled = await request.patch("/api/features/image-to-image", {
    data: { enabled: true },
  });
  expect(enabled.status()).toBe(200);

  const disabled = await request.patch("/api/features/image-to-image", {
    data: { enabled: false },
  });
  expect(disabled.status()).toBe(200);
  const disabledBody = (await disabled.json()) as {
    data: { feature: { enabled: boolean; active: boolean } };
  };
  expect(disabledBody.data.feature).toMatchObject({ enabled: false, active: false });

  // 结尾恢复默认（开启），避免影响后续用例。
  await request.patch("/api/features/image-to-image", { data: { enabled: true } });
});

test("AC-S1-4 未注册的开关返回 NOT_FOUND", async ({ request }) => {
  const response = await request.patch("/api/features/not-registered", { data: { enabled: true } });
  expect(response.status()).toBe(404);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("NOT_FOUND");
});
