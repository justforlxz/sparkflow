import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ACCOUNT, ensureAccount } from "./support/auth";

/**
 * 设计系统落地的端到端验收（MKACG-913 AC-D-4 / AC-D-5 / AC-D-7）。
 *
 * - AC-D-4：375×812 下六个页面 `scrollWidth === clientWidth`。
 * - AC-D-5：键盘 Tab 遍历主要页面，焦点环可见、不落在 body 上（没有焦点丢失）。
 * - AC-D-7：hover 与 focus-visible 真实生效；禁用控件不响应点击且有说明。
 *
 * 设计变量本身的一致性、对比度与「不使用默认色阶」在单测 `src/components/ui/design-tokens.test.ts`
 * 里检查（AC-D-1 / AC-D-2 / AC-D-6），这里只测浏览器里看得见的行为。
 */

const PNG_ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const createdIds: string[] = [];

const VIEWPORT = { width: 375, height: 812 };

async function loginInBrowser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(ACCOUNT.email);
  await page.getByLabel("密码").fill(ACCOUNT.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

async function createCollection(request: APIRequestContext): Promise<string> {
  const response = await request.post("/api/collections", {
    multipart: {
      name: `e2e-design-${randomUUID().slice(0, 8)}`,
      platform: "小红书",
      image: { name: "a.png", mimeType: "image/png", buffer: PNG_ONE_PIXEL },
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { ok: true; data: { id: string } };
  createdIds.push(body.data.id);
  return body.data.id;
}

test.afterEach(async ({ request }) => {
  await ensureAccount(request);
  for (const id of createdIds.splice(0)) {
    await request.delete(`/api/collections/${id}`);
  }
});

/** 页面根元素的内容宽度与可视宽度；两者相等表示没有横向溢出。 */
async function widths(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

test("AC-D-4 375×812 下工作台、资源夹列表、资源夹详情、任务、发布、设置六个页面都不横向溢出", async ({
  page,
  request,
}) => {
  await ensureAccount(request);
  const collectionId = await createCollection(request);
  await loginInBrowser(page);
  await page.setViewportSize(VIEWPORT);

  const routes = [
    { href: "/", label: "工作台" },
    { href: "/collections", label: "资源夹列表" },
    { href: `/collections/${collectionId}`, label: "资源夹详情" },
    { href: "/tasks", label: "创作任务" },
    { href: "/published", label: "发布记录" },
    { href: "/settings", label: "设置" },
  ];

  for (const route of routes) {
    await page.goto(route.href);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const measured = await widths(page);
    expect(measured.scrollWidth, `${route.label} 在 375×812 下不应横向溢出`).toBe(
      measured.clientWidth,
    );
  }

  // 弹窗是窄屏最容易溢出的地方：打开「新建资源夹」再看一次。
  await page.goto("/collections");
  await page.getByRole("button", { name: "新建媒体资源夹" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const dialog = await page.getByRole("dialog").boundingBox();
  expect(dialog?.width ?? 0).toBeLessThanOrEqual(VIEWPORT.width);
  const withDialog = await widths(page);
  expect(withDialog.scrollWidth, "新建资源夹弹窗在 375×812 下不应横向溢出").toBe(
    withDialog.clientWidth,
  );
});

interface FocusSnapshot {
  tag: string;
  testId: string | null;
  role: string;
  outlineStyle: string;
  outlineWidth: number;
  outlineColor: string;
  visible: boolean;
  /** `next dev` 注入的调试门户也是可聚焦的，它不属于产品界面，遍历时跳过。 */
  inDevOverlay: boolean;
}

/** 当前焦点元素的样子：标签、说明、焦点环三要素。 */
async function focusSnapshot(page: Page): Promise<FocusSnapshot | null> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return null;
    const style = getComputedStyle(active);
    const rect = active.getBoundingClientRect();
    return {
      tag: active.tagName.toLowerCase(),
      testId: active.getAttribute("data-testid"),
      role: active.getAttribute("role") ?? "",
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineColor: style.outlineColor,
      visible: rect.width > 0 && rect.height > 0,
      inDevOverlay: Boolean(active.closest("nextjs-portal")),
    };
  });
}

test("AC-D-5 键盘 Tab 遍历工作台、资源夹列表与设置页：焦点环可见，焦点不丢失", async ({
  page,
  request,
}) => {
  await ensureAccount(request);
  await loginInBrowser(page);
  await page.setViewportSize(VIEWPORT);

  // 每个页面至少有 8 个可聚焦元素（侧栏 5 个导航项 + 退出 + 页头主操作 + 区块内操作），
  // 走 8 步能覆盖到侧栏与内容区，又不会因为走到页面末尾而落到浏览器界面上。
  const tabStops = 8;
  for (const href of ["/", "/collections", "/settings"]) {
    await page.goto(href);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    let checked = 0;
    let presses = 0;
    let snapshot = await focusSnapshot(page);
    // `next dev` 的调试门户可聚焦且排在页面之前：跳过它，只断言产品界面的焦点。
    while (checked < tabStops && presses < tabStops * 3) {
      await page.keyboard.press("Tab");
      presses += 1;
      // 焦点环颜色也是 150ms 过渡的目标：等过渡结束再取色，否则读到的是过渡起点（文字色）。
      await page.waitForTimeout(200);
      snapshot = await focusSnapshot(page);
      if (snapshot?.inDevOverlay) continue;

      // 焦点落在 body 上就是「焦点丢失」：键盘用户不知道自己在哪里。
      expect(snapshot?.tag, `${href} 第 ${checked + 1} 个焦点不应落在 body 上`).not.toBe("body");
      expect(snapshot?.visible, `${href} 第 ${checked + 1} 个焦点元素应该可见`).toBe(true);
      // 2px 实线焦点环，颜色来自 --focus（#1a6dff）。
      expect(snapshot?.outlineStyle, `${href} 第 ${checked + 1} 个焦点环样式`).toBe("solid");
      expect(
        snapshot?.outlineWidth ?? 0,
        `${href} 第 ${checked + 1} 个焦点环宽度`,
      ).toBeGreaterThanOrEqual(2);
      expect(snapshot?.outlineColor, `${href} 第 ${checked + 1} 个焦点环颜色`).toBe(
        "rgb(26, 109, 255)",
      );
      checked += 1;
    }

    expect(checked, `${href} 至少要走满 ${tabStops} 个焦点`).toBe(tabStops);
  }
});

/** 一直 Tab 到焦点落在指定文字的可聚焦元素上，模拟真实键盘用户走到目标控件。 */
async function tabUntilText(page: Page, text: string, maxTabs = 12): Promise<void> {
  for (let index = 0; index < maxTabs; index += 1) {
    await page.keyboard.press("Tab");
    const reached = await page.evaluate(
      (target) => (document.activeElement?.textContent ?? "").trim() === target,
      text,
    );
    if (reached) return;
  }
  throw new Error(`Tab 走了 ${maxTabs} 步仍未到达「${text}」`);
}

test("AC-D-2 AC-D-6 设计变量在浏览器里真实生效：页面底、卡片、强调色、控件边框取色与 tokens.md 一致", async ({
  page,
  request,
}) => {
  await ensureAccount(request);
  await loginInBrowser(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  const colors = await page.evaluate(() => {
    const pick = (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`找不到 ${selector}`);
      const style = getComputedStyle(node);
      return {
        background: style.backgroundColor,
        border: style.borderTopColor,
        color: style.color,
        shadow: style.boxShadow,
      };
    };
    return {
      page: getComputedStyle(document.body).backgroundColor,
      sidebar: pick('aside[aria-label="应用侧栏"]'),
      activeNav: pick('[data-testid="nav-dashboard"]'),
      // 统计卡的外层是 Panel（dl 的直接子元素），里面的 dd 才是数字。
      card: pick("dl[aria-label] > div"),
      statNumber: pick('[data-testid="stat-collections"]'),
    };
  });

  // 取色来自 globals.css 的设计变量：--bg #f6f7f9、--panel #ffffff、--accent-strong #c11f3a。
  expect(colors.page).toBe("rgb(246, 247, 249)");
  expect(colors.sidebar.background).toBe("rgb(255, 255, 255)");
  expect(colors.sidebar.border).toBe("rgb(226, 229, 234)");
  expect(colors.activeNav.background).toBe("rgb(193, 31, 58)");
  expect(colors.activeNav.color).toBe("rgb(255, 255, 255)");
  // 卡片：--line 边框 + 唯一的阴影档；统计数字是 --ink。
  expect(colors.card.border).toBe("rgb(226, 229, 234)");
  expect(colors.card.shadow).not.toBe("none");
  expect(colors.statNumber.color).toBe("rgb(22, 24, 29)");

  // 次操作按钮的边框就是「控件边框」那一档（≥3:1），主操作是深色实心。
  await page.goto("/collections");
  const buttons = await page.evaluate(() => {
    const primary = document.querySelector('button[type="button"]') as HTMLElement;
    const secondary = document.querySelector('button[type="submit"]') as HTMLElement;
    return {
      primary: primary ? getComputedStyle(primary).backgroundColor : null,
      secondaryBorder: secondary ? getComputedStyle(secondary).borderTopColor : null,
    };
  });
  expect(buttons.primary).toBe("rgb(22, 24, 29)");
  expect(buttons.secondaryBorder).toBe("rgb(127, 135, 148)");
});

/** 元素的计算样式快照，用于判断 hover 是否真的改变了外观。 */
async function visualState(page: Page, selector: string) {
  return page.locator(selector).evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      background: style.backgroundColor,
      border: `${style.borderTopColor} ${style.borderTopWidth}`,
      outline: `${style.outlineStyle} ${style.outlineWidth}`,
    };
  });
}

async function hoverChanges(page: Page, selector: string): Promise<void> {
  const locator = page.locator(selector).first();
  await expect(locator).toBeVisible();
  const before = await visualState(page, selector);
  await locator.hover();
  // 过渡时长 150ms：等过渡走完再取色，避免读到中间值。
  await page.waitForTimeout(250);
  const after = await visualState(page, selector);
  expect(
    `${after.background}/${after.border}`,
    `${selector} 悬停后应该改变底色或边框`,
  ).not.toBe(`${before.background}/${before.border}`);
  // 鼠标移开，避免影响后续断言。
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
}

test("AC-D-7 主要可点元素有 hover 与 focus-visible，禁用控件不响应点击且有说明", async ({
  page,
  request,
}) => {
  await ensureAccount(request);
  await loginInBrowser(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  // hover：侧栏导航、主操作按钮、搜索输入框各自都要有反馈。
  await page.goto("/");
  await hoverChanges(page, '[data-testid="nav-collections"]');

  await page.goto("/collections");
  await hoverChanges(page, "form input[type=search]");
  await hoverChanges(page, 'button:has-text("新建媒体资源夹")');

  // focus-visible：用键盘走到主操作按钮上，焦点环必须出现（鼠标悬停不算）。
  await page.goto("/collections");
  const primaryButton = page.getByRole("button", { name: "新建媒体资源夹" });
  await tabUntilText(page, "新建媒体资源夹");
  await page.waitForTimeout(200);
  const focused = await focusSnapshot(page);
  expect(focused?.tag).toBe("button");
  expect(focused?.outlineStyle).toBe("solid");
  expect(focused?.outlineWidth ?? 0).toBeGreaterThanOrEqual(2);
  await expect(primaryButton).toBeFocused();

  // 禁用态：本版本未实现的功能开关不可操作，并且旁边写明了原因。
  await page.goto("/settings");
  const disabledFlag = page.locator('[data-testid="feature-flag-image-to-image"]');
  const checkbox = disabledFlag.locator('input[type="checkbox"]');
  await expect(checkbox).toBeDisabled();
  await expect(disabledFlag.getByTestId("feature-unimplemented")).toHaveText("本版本未实现");
  await checkbox.click({ force: true });
  await expect(checkbox).not.toBeChecked();
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("AC-D-7 弹窗宽度由调用方选档，不被基类覆盖", async ({ page, request }) => {
  // 回归护栏：曾经把 `max-w-lg` 写在弹窗基类里，调用方再追加 `max-w-2xl` 不生效
  // （同一组 max-width 工具类谁生效取决于生成样式表的先后），资源夹与发布准备弹窗退回 512px。
  await ensureAccount(request);
  await loginInBrowser(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto("/collections");
  await page.getByRole("button", { name: "新建媒体资源夹" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const collectionDialog = await page.getByRole("dialog").boundingBox();
  // max-w-2xl = 42rem = 672px
  expect(Math.round(collectionDialog?.width ?? 0), "资源夹弹窗宽度").toBe(672);

  await page.goto("/settings");
  await page.getByRole("button", { name: "新增网关" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const gatewayDialog = await page.getByRole("dialog").boundingBox();
  // max-w-xl = 36rem = 576px
  expect(Math.round(gatewayDialog?.width ?? 0), "网关弹窗宽度").toBe(576);
});
