import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { QUAD_COPY } from "../../src/modules/media-collection/constants";
import { loginInBrowser } from "./support/auth";
import {
  cleanupLibraryData,
  createCollection,
  createGateway,
  extractAndWait,
  listLibrary,
  prepareAgents,
  uniqueName,
} from "./support/library";

/**
 * 四角框选 + 单应透视矫正的端到端验收（MKACG-1001）。
 *
 * 三层证据各管一段：
 * - 单测（`quad.test.ts`、`extraction.test.ts`）证明「几何怎么算」与「graphic 不调模型」；
 * - 集成（`tests/integration/quad-rectify.test.ts`）证明「落盘、落库、比例复原、可复现」；
 * - 这里证明**用户看得见的行为**：拖角、保存被拒、角标、产物字节等于矫正图。
 *
 * 产物字节的对照是本单的核心断言（AC-QUAD-9、AC-QUAD-10）：
 * mock 出图是一张纯白 PNG，与含内容的矫正图字节不同，所以「字节等于矫正图」就证明没有走模型。
 */

/** 一张有内容的 2:1 「桌垫」：左半深蓝、右半橙，中间一条浅色横带。矫正前后结构必须一致。 */
async function patternedMat(): Promise<Buffer> {
  const width = 800;
  const height = 400;
  const left = await sharp({
    create: { width: width / 2, height, channels: 3, background: { r: 40, g: 70, b: 110 } },
  })
    .png()
    .toBuffer();
  const right = await sharp({
    create: { width: width / 2, height, channels: 3, background: { r: 220, g: 150, b: 60 } },
  })
    .png()
    .toBuffer();
  const band = await sharp({
    create: { width, height: 40, channels: 3, background: { r: 240, g: 235, b: 220 } },
  })
    .png()
    .toBuffer();

  return sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      { input: left, top: 0, left: 0 },
      { input: right, top: 0, left: width / 2 },
      { input: band, top: Math.round(height * 0.45), left: 0 },
    ])
    .png()
    .toBuffer();
}

/** 整幅画面就是这块图案：四个角正好落在图片四角。 */
const FULL_FRAME = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** 只俯仰的透视：一组对边保持平行，焦距无从解出 → 比例估算失败（AC-QUAD-5）。 */
const UNESTIMABLE = [
  [0.2, 0.2],
  [0.8, 0.2],
  [0.9, 0.8],
  [0.1, 0.8],
];

async function saveQuad(
  request: Parameters<typeof createCollection>[0],
  assetId: string,
  body: { kind: "surface" | "pattern"; points: number[][]; realSize?: { width: number; height: number } },
): Promise<{ aspectSource: string; aspectRatio: number; rectifiedWidth: number; rectifiedHeight: number }> {
  const response = await request.put(`/api/library/assets/${assetId}/quad`, { data: body });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: never }).data;
}

/** 拖一个手柄到图片盒子里的归一化坐标。 */
async function dragHandle(page: Page, index: number, target: { x: number; y: number }): Promise<void> {
  const box = page.getByTestId("quad-editor-box");
  const handle = box.getByTestId("quad-editor-handle").nth(index);
  const boxRect = await box.boundingBox();
  const handleRect = await handle.boundingBox();
  if (!boxRect || !handleRect) throw new Error("编辑器图片或手柄不在可视区域");

  await page.mouse.move(handleRect.x + handleRect.width / 2, handleRect.y + handleRect.height / 2);
  await page.mouse.down();
  await page.mouse.move(boxRect.x + boxRect.width * target.x, boxRect.y + boxRect.height * target.y, {
    steps: 8,
  });
  await page.mouse.up();
}

async function openEditor(page: Page): Promise<void> {
  await page.getByTestId("asset-quad-open").first().click();
  await expect(page.getByTestId("quad-editor")).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await prepareAgents(request);
});

test.afterAll(async ({ request }) => {
  await cleanupLibraryData(request);
});

test("AC-QUAD-4 凹四边形不给保存：拖出凹陷时保存按钮禁用并给出可读提示", async ({ page, request }) => {
  const mat = await patternedMat();
  const collection = await createCollection(request, uniqueName("AC-QUAD-4"), 1, {
    imageBytes: mat,
  });

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);
  await openEditor(page);

  // 默认四角是合法凸四边形：可以保存。
  await expect(page.getByTestId("quad-save")).toBeEnabled();

  // 把右下角拖进另外三点围成的三角形内 → 凹四边形。
  await dragHandle(page, 2, { x: 0.3, y: 0.3 });

  await expect(page.getByTestId("quad-invalid")).toBeVisible();
  await expect(page.getByTestId("quad-invalid")).toContainText("凸四边形");
  await expect(page.getByTestId("quad-save")).toBeDisabled();

  // 恢复默认四角后又能保存。
  await page.getByTestId("quad-reset").click();
  await expect(page.getByTestId("quad-invalid")).toHaveCount(0);
  await expect(page.getByTestId("quad-save")).toBeEnabled();
});

test("AC-QUAD-1 拖角保存：原图标为已校正，矫正图能从鉴权路由读到", async ({ page, request }) => {
  const mat = await patternedMat();
  const collection = await createCollection(request, uniqueName("AC-QUAD-1"), 1, {
    imageBytes: mat,
  });
  const assetId = collection.assetIds[0] as string;

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);

  // 未框选时左栏如实标注「未校正」（AC-QUAD-7）。
  await expect(page.getByTestId("asset-quad-badge")).toHaveText(QUAD_COPY.uncorrectedBadge);

  await openEditor(page);
  await page.getByTestId("quad-kind").nth(1).check();
  await page.getByTestId("quad-save").click();

  await expect(page.getByTestId("quad-editor")).toHaveCount(0);
  await expect(page.getByTestId("asset-quad-badge")).toHaveText(
    QUAD_COPY.correctedBadge("图案本身的四个角"),
  );

  // 矫正图真的落盘并能从鉴权路由读到。
  const rectified = await request.get(`/api/files/assets/${assetId}/rectified`);
  expect(rectified.status()).toBe(200);
  expect(rectified.headers()["content-type"]).toContain("image/png");
  const metadata = await sharp(await rectified.body()).metadata();
  expect(metadata.format).toBe("png");
  expect(metadata.width).toBeGreaterThan(0);
  expect(metadata.height).toBeGreaterThan(0);
});

test("AC-QUAD-9 AC-QUAD-10 图案四角 + 形象设计：产物字节等于矫正图，两次运行完全一致", async ({
  page,
  request,
}) => {
  await createGateway(request);
  const mat = await patternedMat();
  const collection = await createCollection(request, uniqueName("AC-QUAD-9"), 1, {
    imageBytes: mat,
  });
  const assetId = collection.assetIds[0] as string;

  const saved = await saveQuad(request, assetId, { kind: "pattern", points: FULL_FRAME });
  expect(saved.rectifiedWidth).toBeGreaterThan(0);

  const rectifiedBytes = Buffer.from(await (await request.get(`/api/files/assets/${assetId}/rectified`)).body());

  const first = await extractAndWait(request, collection, { categories: ["graphic"] });
  expect(first.status).toBe("succeeded");
  const second = await extractAndWait(request, collection, { categories: ["graphic"] });
  expect(second.status).toBe("succeeded");

  const library = await listLibrary(request, collection.id);
  const items = library.groups.flatMap((group) => group.items);
  expect(items).toHaveLength(2);
  expect(items.every((item) => item.category === "graphic")).toBe(true);

  const produced: Buffer[] = [];
  for (const item of items) {
    const response = await request.get(item.url);
    expect(response.status()).toBe(200);
    produced.push(Buffer.from(await response.body()));
  }

  // MUST：产物就是单应矫正的原像素，不是模型重画。
  for (const bytes of produced) {
    expect(bytes.equals(rectifiedBytes), "产物字节应等于矫正图").toBe(true);
  }
  // AC-QUAD-10：同一张图连跑两次，字节完全一致（证明没有模型参与）。
  expect(produced[0]?.equals(produced[1] as Buffer)).toBe(true);

  // 界面必须把来源说清楚（AC-QUAD-9 的界面部分）。
  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);
  const badge = page.getByTestId("column-results").getByTestId("library-source-badge").first();
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("data-source", "rectified");
  await expect(badge).toHaveAttribute("title", "几何矫正（原样）");
  await expect(page.getByTestId("result-card-quad").first()).toContainText("已校正");
});

test("AC-QUAD-11 AC-QUAD-7 未框选：形象设计走模型路径并标注「模型提取（可能重画）」", async ({
  page,
  request,
}) => {
  await createGateway(request);
  const mat = await patternedMat();
  const collection = await createCollection(request, uniqueName("AC-QUAD-11"), 1, {
    imageBytes: mat,
  });

  const run = await extractAndWait(request, collection, { categories: ["graphic"] });
  expect(run.status).toBe("succeeded");

  const library = await listLibrary(request, collection.id);
  const item = library.groups.flatMap((group) => group.items)[0];
  expect(item).toBeDefined();

  // 走模型：产物是 mock 的纯白图，不是原图像素。
  const metadata = await sharp(await (await request.get(item!.url)).body()).metadata();
  expect(metadata.width).toBeGreaterThan(0);

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);

  const badge = page.getByTestId("column-results").getByTestId("library-source-badge").first();
  await expect(badge).toHaveAttribute("data-source", "model");
  await expect(badge).toHaveAttribute("title", "模型提取（可能重画）");
  // 原图未校正：结果卡如实标注（AC-QUAD-7）。
  await expect(page.getByTestId("result-card-quad").first()).toContainText("未校正");
});

test("AC-QUAD-5 估算失败：界面显示「比例未能估算」，保存仍然成功且不阻断", async ({
  page,
  request,
}) => {
  const mat = await patternedMat();
  const collection = await createCollection(request, uniqueName("AC-QUAD-5"), 1, {
    imageBytes: mat,
  });
  const assetId = collection.assetIds[0] as string;

  const saved = await saveQuad(request, assetId, { kind: "surface", points: UNESTIMABLE });
  expect(saved.aspectSource).toBe("fallback");

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);
  await openEditor(page);

  // 编辑器复用后端那份判定：估算失败时如实说明并说明不阻断。
  await expect(page.getByTestId("quad-aspect")).toContainText("比例未能估算");
  await expect(page.getByTestId("quad-save")).toBeEnabled();

  // 四角已保存，矫正图也生成了（不阻断）。
  const row = await request.get(`/api/files/assets/${assetId}/rectified`);
  expect(row.status()).toBe(200);
});

test("AC-QUAD-6 手输实际尺寸优先：按 900×300 出 1536×512", async ({ page, request }) => {
  const mat = await patternedMat();
  const collection = await createCollection(request, uniqueName("AC-QUAD-6"), 1, {
    imageBytes: mat,
  });
  const assetId = collection.assetIds[0] as string;

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);
  await openEditor(page);

  await page.getByTestId("quad-real-width").fill("900");
  await page.getByTestId("quad-real-height").fill("300");
  await expect(page.getByTestId("quad-aspect")).toContainText("3.00 : 1");
  await expect(page.getByTestId("quad-aspect")).toContainText("按你填的尺寸");

  await page.getByTestId("quad-save").click();
  await expect(page.getByTestId("quad-editor")).toHaveCount(0);

  const metadata = await sharp(
    await (await request.get(`/api/files/assets/${assetId}/rectified`)).body(),
  ).metadata();
  expect(metadata.width).toBe(1536);
  expect(metadata.height).toBe(512);
});
