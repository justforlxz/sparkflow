import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { MOCK_SCRIPT_HINTS } from "../../src/modules/image-generation/mock-script";
import { loginInBrowser } from "./support/auth";
import {
  cleanupLibraryData,
  createCollection,
  createGateway,
  extractAndWait,
  prepareAgents,
  uniqueName,
} from "./support/library";

/**
 * 资源夹三栏工作区的界面验收（MKACG-974、ADR 0012 第 4 条）。
 *
 * 三档视口（1440 / 1240 / 375）都要断言：三栏宽度、整页锁高度、只有中列滚动、
 * 窄屏回落单列且页面可滚、没有横向溢出。数据准备走接口，断言只看界面上看得见的东西。
 */

/** 1×1 的 PNG：内容判断只看魔数。 */
const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function png(name: string) {
  return { name, mimeType: "image/png", buffer: PNG_ONE_PIXEL };
}

/** 本文件往总资源库直接上传的照片：用例结束后删掉，避免污染其它用例的「总库里有几张」。 */
const poolAssetIds: string[] = [];

async function uploadToPool(request: APIRequestContext, name = "pool.png"): Promise<string> {
  const response = await request.post("/api/library/assets", { multipart: { "images-0": png(name) } });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { data: Array<{ id: string }> };
  const id = body.data[0]?.id;
  if (!id) throw new Error("上传到总资源库没有返回照片 id");
  poolAssetIds.push(id);
  return id;
}

async function collectionAssetCount(request: APIRequestContext, id: string): Promise<number> {
  const response = await request.get(`/api/collections/${id}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { assets: unknown[] } }).data.assets.length;
}

async function poolTotal(request: APIRequestContext): Promise<number> {
  const response = await request.get("/api/library?pageSize=60");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { total: number } }).data.total;
}

/**
 * 等 `body` 的 `overflow` 落到期望值再量测。
 *
 * 锁高度是客户端 effect 做的（只有宽屏才锁），`page.goto` 返回时 React 可能还没 hydrate，
 * 直接量会读到 `visible`。窄屏同理：从宽屏切过来要等 effect 把锁解掉。
 */
async function waitForBodyOverflow(page: Page, expected: string): Promise<void> {
  await expect
    .poll(async () => page.evaluate(() => getComputedStyle(document.body).overflow), {
      timeout: 10_000,
    })
    .toBe(expected);
}

/** 三栏的几何与页面滚动状态：AC-UI-1 ~ AC-UI-3 都用这一份量测。 */
async function layout(page: Page) {
  return page.evaluate(() => {
    const rect = (testId: string) =>
      document.querySelector(`[data-testid="${testId}"]`)?.getBoundingClientRect() ?? null;
    const left = rect("column-source");
    const middle = rect("column-results");
    const right = rect("column-settings");
    return {
      left: left && { top: left.top, width: left.width },
      middle: middle && { top: middle.top, width: middle.width },
      right: right && { top: right.top, width: right.width },
      bodyOverflow: getComputedStyle(document.body).overflow,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollY: window.scrollY,
    };
  });
}

test.beforeEach(async ({ request }) => {
  await prepareAgents(request);
});

test.afterAll(async ({ request }) => {
  await cleanupLibraryData(request);
  for (const id of poolAssetIds.splice(0)) {
    await request.delete(`/api/library/${id}`);
  }
});

test("AC-UI-1 AC-UI-2 1440 视口：三栏 232 / ≥600 / 268，整页锁高度，只有中列滚动", async ({
  page,
  request,
}) => {
  await createGateway(request);
  // 8 张原图：中列内容一定超过一屏，才测得出「只有中列滚」。
  const collection = await createCollection(request, uniqueName("AC-UI-1"), 8);

  await loginInBrowser(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/collections/${collection.id}`);
  await waitForBodyOverflow(page, "hidden");

  const measured = await layout(page);
  expect(Math.round(measured.left?.width ?? 0), "左栏宽度").toBe(232);
  expect(Math.round(measured.middle?.width ?? 0), "中栏宽度").toBeGreaterThanOrEqual(600);
  expect(Math.round(measured.right?.width ?? 0), "右栏宽度").toBe(268);

  // 整页锁高度：body 不滚，文档高度等于视口高度。
  expect(measured.bodyOverflow, "body 计算样式").toBe("hidden");
  expect(measured.scrollHeight, "页面 scrollHeight 等于 clientHeight").toBe(
    measured.clientHeight,
  );

  // 中列真的能滚：找到包住结果卡的滚动容器，滚 300px。
  const scrolled = await page.evaluate(() => {
    let node = document.querySelector('[data-testid="result-card"]')?.parentElement ?? null;
    while (node && node.scrollHeight <= node.clientHeight) node = node.parentElement;
    if (!node) return null;
    node.scrollTop = 300;
    return { top: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
  });
  expect(scrolled, "中列应当有一个可滚动容器").not.toBeNull();
  expect(scrolled?.scrollHeight ?? 0).toBeGreaterThan(scrolled?.clientHeight ?? 0);
  expect(scrolled?.top, "中列滚动 300px 后 scrollTop").toBe(300);

  // 左右两栏不跟着滚，页面本身也没滚。
  const afterScroll = await layout(page);
  expect(Math.round(afterScroll.left?.top ?? -1), "左栏 top 不变").toBe(
    Math.round(measured.left?.top ?? -2),
  );
  expect(Math.round(afterScroll.right?.top ?? -1), "右栏 top 不变").toBe(
    Math.round(measured.right?.top ?? -2),
  );
  expect(afterScroll.scrollY, "window.scrollY").toBe(0);
});

test("AC-UI-3 1240 视口仍是三栏；1120 视口回落单列且页面可滚", async ({ page, request }) => {
  await createGateway(request);
  const collection = await createCollection(request, uniqueName("AC-UI-3"), 4);

  await loginInBrowser(page);
  await page.setViewportSize({ width: 1240, height: 900 });
  await page.goto(`/collections/${collection.id}`);
  await waitForBodyOverflow(page, "hidden");

  const wide = await layout(page);
  expect(Math.round(wide.left?.width ?? 0), "1240 视口左栏").toBe(232);
  expect(Math.round(wide.right?.width ?? 0), "1240 视口右栏").toBe(268);
  expect(Math.round(wide.left?.top ?? 0), "1240 视口三栏同一行").toBe(
    Math.round(wide.middle?.top ?? -1),
  );
  expect(Math.round(wide.middle?.top ?? 0)).toBe(Math.round(wide.right?.top ?? -1));

  // 1120：回落单列流式，页面滚动，三块按 素材 → 结果 → 设置 排列。
  await page.setViewportSize({ width: 1120, height: 900 });
  await waitForBodyOverflow(page, "visible");
  const narrow = await layout(page);
  expect(narrow.bodyOverflow, "窄屏不锁 body").toBe("visible");
  expect(Math.round(narrow.left?.width ?? 0), "窄屏左栏占满一行").toBeGreaterThan(232);
  expect(narrow.left?.top ?? 0, "素材在最上面").toBeLessThan(narrow.middle?.top ?? 0);
  expect(narrow.middle?.top ?? 0, "结果在中间").toBeLessThan(narrow.right?.top ?? 0);
  expect(narrow.scrollHeight, "窄屏页面可滚").toBeGreaterThan(narrow.clientHeight);

  await page.evaluate(() => window.scrollTo(0, 200));
  expect(await page.evaluate(() => window.scrollY), "窄屏真的能滚").toBe(200);
});

test("AC-UI-4 三列面板圆角 14px、描边 #e2e5ea、标题栏内边距 10px 14px 完全一致；结果卡无阴影", async ({
  page,
  request,
}) => {
  await createGateway(request);
  const collection = await createCollection(request, uniqueName("AC-UI-4"), 1);
  await extractAndWait(request, collection, { categories: ["topdown", "texture", "graphic"] });

  await loginInBrowser(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/collections/${collection.id}`);

  const panels = await page.evaluate(() =>
    ["panel-source", "panel-results", "panel-settings"].map((testId) => {
      const panel = document.querySelector(`[data-testid="${testId}"]`);
      const header = panel?.firstElementChild;
      if (!panel || !header) return null;
      const panelStyle = getComputedStyle(panel);
      const headerStyle = getComputedStyle(header);
      return {
        radius: panelStyle.borderRadius,
        borderColor: panelStyle.borderTopColor,
        headerPadding: [
          headerStyle.paddingTop,
          headerStyle.paddingRight,
          headerStyle.paddingBottom,
          headerStyle.paddingLeft,
        ].join(" "),
      };
    }),
  );

  for (const panel of panels) {
    expect(panel, "三列都要渲染出面板").not.toBeNull();
    expect(panel?.radius, "面板圆角").toBe("14px");
    expect(panel?.borderColor, "面板描边").toBe("rgb(226, 229, 234)");
    expect(panel?.headerPadding, "标题栏内边距").toBe("10px 14px 10px 14px");
  }

  const shadow = await page.evaluate(
    () => getComputedStyle(document.querySelector('[data-testid="result-card"]')!).boxShadow,
  );
  expect(shadow, "结果卡不自带阴影").toBe("none");
});

test("AC-UI-5 添加弹窗：标题带夹名，本地上传 2 张 + 总库 1 张 → 底栏合计 3 张，确认后夹内 +3、总库 +2", async ({
  page,
  request,
}) => {
  await createGateway(request);
  const name = uniqueName("AC-UI-5");
  const collection = await createCollection(request, name, 1);
  // 总资源库是全库共享的（别的用例也会往里放照片），只按自己这张的文件名定位。
  const poolName = `pool-only-${name}.png`;
  await uploadToPool(request, poolName);

  const poolBefore = await poolTotal(request);
  expect(await collectionAssetCount(request, collection.id)).toBe(1);

  await loginInBrowser(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/collections/${collection.id}`);

  await page.getByTestId("add-assets-open").click();
  const dialog = page.getByTestId("add-assets-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText(`添加到「${name}」`);

  // 本地上传 2 张。
  await dialog.getByTestId("add-assets-file-input").setInputFiles([png("x1.png"), png("x2.png")]);
  await expect(dialog.getByTestId("add-assets-summary")).toHaveText(
    "合计 2 张（本地上传 2 张 · 从资源库 0 张）",
  );

  // 总资源库页签：已在夹内的那张置灰标「已加」，只能选另一张。
  await dialog.getByTestId("add-assets-tab-pool").click();
  const poolItems = dialog.getByTestId("add-assets-pool-item");
  // 已在夹内的照片置灰标「已加」，且不可选。
  const already = poolItems.filter({ hasText: "已加" });
  await expect(already).toHaveCount(1);
  await expect(already.getByRole("checkbox")).toBeDisabled();

  const mine = poolItems.filter({ hasText: poolName });
  await expect(mine).toHaveCount(1);
  await expect(mine.getByRole("checkbox")).not.toBeDisabled();
  await mine.getByRole("checkbox").check();
  await expect(dialog.getByTestId("add-assets-summary")).toHaveText(
    "合计 3 张（本地上传 2 张 · 从资源库 1 张）",
  );
  await expect(dialog.getByTestId("add-assets-confirm")).toHaveText("添加 3 张");

  await dialog.getByTestId("add-assets-confirm").click();
  await expect(dialog).toHaveCount(0);

  // 夹内 +3；总库 +2（本地上传的两张同时入池）。
  await expect
    .poll(() => collectionAssetCount(request, collection.id), { timeout: 20_000 })
    .toBe(4);
  expect(await poolTotal(request), "总库 +2").toBe(poolBefore + 2);
  // 左栏确实显示 4 张原图。
  await expect(page.getByTestId("column-source").getByTestId("image-thumbnail")).toHaveCount(4);
});

test("AC-UI-6 弹窗里已在夹内的照片置灰不可选；Esc 可关", async ({ page, request }) => {
  await createGateway(request);
  const collection = await createCollection(request, uniqueName("AC-UI-6"), 1);
  await uploadToPool(request, `pool-2-${collection.id}.png`);

  await loginInBrowser(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/collections/${collection.id}`);

  await page.getByTestId("add-assets-open").click();
  const dialog = page.getByTestId("add-assets-dialog");
  await dialog.getByTestId("add-assets-tab-pool").click();

  const poolItems = dialog.getByTestId("add-assets-pool-item");
  await expect(poolItems.first()).toBeVisible();
  const already = poolItems.filter({ hasText: "已加" });
  await expect(already).toHaveCount(1);
  await expect(already.getByRole("checkbox")).toBeDisabled();
  // 置灰不可选：点了也不会进合计。
  await expect(dialog.getByTestId("add-assets-summary")).toHaveText(
    "合计 0 张（本地上传 0 张 · 从资源库 0 张）",
  );
  await expect(dialog.getByTestId("add-assets-confirm")).toBeDisabled();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("add-assets-open")).toBeFocused();
});

test("AC-UI-7 运行中标题下方出现进度条与百分比，进度随 progress.done/total 前进；结束后换成状态标签", async ({
  page,
  request,
}) => {
  await createGateway(request);
  const collection = await createCollection(request, uniqueName("AC-UI-7"), 2);

  await loginInBrowser(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/collections/${collection.id}`);

  // mock 出图只花几毫秒。界面按 PRD 每 3 秒轮询一次（`docs/prd/07-results.md` MUST 4），
  // 所以让每次调用慢 1500ms、一次运行约 9 秒，3 秒一轮能稳定取到两个中间值。
  await page.getByTestId("extra-prompt").fill(`${MOCK_SCRIPT_HINTS.delayImageMs}-1500`);
  await page.getByTestId("extract-submit").click();

  await expect(page.getByTestId("inline-progress")).toBeVisible();
  await expect(page.getByTestId("inline-progress")).toContainText("提取中");

  // 记下界面上出现过的每一个百分比：至少两个不同值，且只增不减。
  const seen: number[] = [];
  await expect
    .poll(
      async () => {
        const text = await page
          .getByTestId("inline-progress-text")
          .textContent()
          .catch(() => null);
        const percent = text ? Number.parseInt(text, 10) : null;
        if (percent !== null && !Number.isNaN(percent) && seen.at(-1) !== percent) {
          seen.push(percent);
        }
        return seen.length;
      },
      { timeout: 40_000, intervals: [50, 100, 100, 200] },
    )
    .toBeGreaterThan(1);

  expect(seen[0], "刚发起时进度是 0%").toBe(0);
  expect(seen, "进度只增不减").toEqual([...seen].sort((left, right) => left - right));
  expect(Math.max(...seen), "进度不会超过 100%").toBeLessThanOrEqual(100);

  // 结束后进度条换成状态标签。
  await expect(page.getByTestId("extraction-run")).toContainText("已完成", { timeout: 60_000 });
  await expect(page.getByTestId("inline-progress")).toHaveCount(0);
});

test("AC-UI-8 结果按原图分组：一张图一张卡，三类产出并排；失败格显示原因与「重试」，不存在格显示原因", async ({
  page,
  request,
}) => {
  await createGateway(request);
  const collection = await createCollection(request, uniqueName("AC-UI-8"), 1);

  // 一张原图跑出三种状态：topdown 判定不存在、texture 正常出图、graphic 生图失败。
  const run = await extractAndWait(request, collection, {
    categories: ["topdown", "texture", "graphic"],
    extraPrompt: `${MOCK_SCRIPT_HINTS.visionAbsentAt}-1 ${MOCK_SCRIPT_HINTS.failImageAt}-2`,
  });
  expect(run.status).toBe("partial");

  await loginInBrowser(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/collections/${collection.id}`);

  const results = page.getByTestId("column-results");
  const cards = results.getByTestId("result-card");
  await expect(cards).toHaveCount(1);

  const card = cards.first();
  // 卡头：原图缩略图 + 文件名 + 三个状态圆点 + 完成数。
  await expect(card.locator("img").first()).toHaveAttribute("alt", /a0\.png/);
  await expect(card.getByTestId("result-dot")).toHaveCount(3);
  await expect(card.getByTestId("result-card-count")).toHaveText("1/3");
  await expect(card.getByTestId("result-card-rerun")).toHaveText("重跑");

  // 三类产出并排：完成=缩略图、不存在=灰底与原因、失败=红框、原因与「重试」。
  await expect(card.getByTestId("image-thumbnail")).toHaveCount(1);
  const absent = card.locator('[data-testid="result-cell"][data-state="absent"]');
  const failed = card.locator('[data-testid="result-cell"][data-state="failed"]');
  await expect(absent).toHaveCount(1);
  await expect(absent).toContainText("不存在");
  await expect(absent.getByTestId("result-cell-reason")).not.toBeEmpty();
  await expect(failed).toHaveCount(1);
  await expect(failed.getByTestId("result-cell-reason")).toContainText("mock");
  await expect(failed.getByTestId("result-cell-retry")).toHaveText("重试");
});

test("AC-UI-9 单格「重试」：点击后该格立刻显示「重试中」+ 扫光，完成后变「完成」", async ({
  page,
  request,
}) => {
  await createGateway(request);
  const collection = await createCollection(request, uniqueName("AC-UI-9"), 1);
  await extractAndWait(request, collection, {
    categories: ["topdown", "texture", "graphic"],
    extraPrompt: `${MOCK_SCRIPT_HINTS.visionAbsentAt}-1 ${MOCK_SCRIPT_HINTS.failImageAt}-2`,
  });

  await loginInBrowser(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/collections/${collection.id}`);

  const results = page.getByTestId("column-results");
  const failed = results.locator('[data-testid="result-cell"][data-state="failed"]');
  await expect(failed).toHaveCount(1);

  await failed.getByTestId("result-cell-retry").click();

  // 立刻变成「重试中」，并且真的在扫光。
  const pending = results.locator('[data-testid="result-cell"][data-state="pending"]');
  await expect(pending).toHaveCount(1);
  await expect(pending).toHaveText("重试中");
  const animation = await pending.evaluate(
    (node) => getComputedStyle(node, "::after").animationName,
  );
  expect(animation, "重试中的格子有扫光动画").toBe("sparkflow-sweep");

  // 重试只重跑这一格：跑完变「完成」，另外两格的结果不受影响。
  await expect(failed).toHaveCount(0, { timeout: 60_000 });
  await expect(results.getByTestId("image-thumbnail")).toHaveCount(2);
  await expect(results.getByTestId("result-card-count")).toHaveText("2/3");
  await expect(
    results.locator('[data-testid="result-cell"][data-state="absent"]'),
    "不存在的那一格没有被重试",
  ).toHaveCount(1);
});

test("AC-UI-10 375 视口无横向溢出；单列；缩略图 2 列；弹窗完整可见", async ({ page, request }) => {
  await createGateway(request);
  const collection = await createCollection(request, uniqueName("AC-UI-10"), 4);
  await uploadToPool(request, "pool-375.png");

  await loginInBrowser(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/collections/${collection.id}`);
  await waitForBodyOverflow(page, "visible");

  const measured = await layout(page);
  expect(measured.scrollWidth, "375 视口不应横向溢出").toBe(measured.clientWidth);
  expect(measured.bodyOverflow, "窄屏不锁 body").toBe("visible");

  // 单列：素材 → 结果 → 设置 依次向下排。
  expect(measured.left?.top ?? 0).toBeLessThan(measured.middle?.top ?? 0);
  expect(measured.middle?.top ?? 0).toBeLessThan(measured.right?.top ?? 0);

  // 缩略图 2 列：前两张在同一行。
  const thumbnailTops = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="column-source"] [data-testid="image-thumbnail"]')]
      .slice(0, 2)
      .map((node) => Math.round(node.getBoundingClientRect().top)),
  );
  expect(thumbnailTops).toHaveLength(2);
  expect(thumbnailTops[0], "缩略图 2 列").toBe(thumbnailTops[1]);

  // 弹窗完整可见：左右都不出视口。
  await page.getByTestId("add-assets-open").click();
  const dialog = page.getByTestId("add-assets-dialog");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box, "弹窗有尺寸").not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0), "弹窗右边缘不出视口").toBeLessThanOrEqual(375);
  const withDialog = await layout(page);
  expect(withDialog.scrollWidth, "弹窗打开后仍不横向溢出").toBe(withDialog.clientWidth);
});
