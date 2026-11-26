import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginInBrowser } from "./support/auth";
import {
  cleanupLibraryData,
  createCollection,
  createGateway,
  prepareAgents,
  uniqueName,
} from "./support/library";

/**
 * 键盘可达性验收（MKACG-1007 AC-UX-1）：聚焦主要按钮时，Enter 与 Space 各自触发**一次**点击。
 *
 * 为什么单独建一份用例、而且坚持用真实按键：这一条曾经被判「按 Enter 没反应」。
 * 原因不在页面（原生 `<button>` 本来就把 Enter 交给浏览器默认动作），而在当时的探针用
 * `Input.dispatchKeyEvent` 发了一个**不带 `text`** 的 Enter —— 浏览器把它当成「原始按键」，
 * 不执行点击这个默认动作；Space 走的是 keyup 路径，所以同一个探针里 Space 是好的。
 * `page.keyboard.press` 发的 Enter 带 `text: "\r"`，与真实键盘一致，所以这里的断言能代表用户。
 *
 * 页面侧不为此添加 `onKeyDown` + `click()` 的补丁：那会让一次按键触发两次点击。
 */

test.beforeEach(async ({ request }) => {
  await prepareAgents(request);
});

test.afterAll(async ({ request }) => {
  await cleanupLibraryData(request);
});

/** 装一次点击计数器：之后每次按键只比较「按之前 / 按之后」的差值，累计的监听不会重复计数。 */
async function installClickCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const counters = window as Window & { __buttonClicks?: number };
    counters.__buttonClicks = 0;
    document.addEventListener(
      "click",
      (event) => {
        if (event.target instanceof Element && event.target.closest("button")) {
          counters.__buttonClicks = (counters.__buttonClicks ?? 0) + 1;
        }
      },
      true,
    );
  });
}

function buttonClicks(page: Page): Promise<number> {
  return page.evaluate(() => (window as Window & { __buttonClicks?: number }).__buttonClicks ?? 0);
}

/** 聚焦目标按钮后按一次真实键，返回这次按键触发的按钮点击次数。 */
async function pressOn(page: Page, target: Locator, key: "Enter" | " "): Promise<number> {
  await target.focus();
  await expect(target).toBeFocused();
  const before = await buttonClicks(page);
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
  return (await buttonClicks(page)) - before;
}

test("AC-UX-1 聚焦「添加」「编辑」「一键提取」时，Enter 与 Space 各触发一次点击", async ({
  page,
  request,
}) => {
  await createGateway(request);
  const collection = await createCollection(request, uniqueName("AC-UX-1"), 2);

  await loginInBrowser(page);
  await page.goto(`/collections/${collection.id}`);
  const addButton = page.getByTestId("add-assets-open");
  await expect(addButton).toBeVisible();
  await installClickCounter(page);

  const addDialog = page.getByTestId("add-assets-dialog");

  // 「添加」+ Enter：弹窗打开，且只点了一次。
  expect(await pressOn(page, addButton, "Enter"), "Enter 只触发一次点击").toBe(1);
  await expect(addDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(addDialog).toHaveCount(0);
  await expect(addButton, "关闭后焦点回到「添加」").toBeFocused();

  // 同一个按钮 + Space：同样只点一次。
  expect(await pressOn(page, addButton, " "), "Space 只触发一次点击").toBe(1);
  await expect(addDialog).toBeVisible();
  // 弹窗里的「取消」也是原生按钮：Enter 关掉它。
  expect(await pressOn(page, addDialog.getByRole("button", { name: "取消" }), "Enter")).toBe(1);
  await expect(addDialog).toHaveCount(0);

  // 「编辑」+ Enter / Space：各自打开一次弹窗。
  const editButton = page.getByRole("button", { name: "编辑", exact: true });
  const editDialog = page.getByRole("dialog", { name: "编辑" });

  expect(await pressOn(page, editButton, "Enter"), "Enter 只触发一次点击").toBe(1);
  await expect(editDialog).toBeVisible();
  await pressOn(page, editDialog.getByRole("button", { name: "取消" }), "Enter");
  await expect(editDialog).toHaveCount(0);

  expect(await pressOn(page, editButton, " "), "Space 只触发一次点击").toBe(1);
  await expect(editDialog).toBeVisible();
  await pressOn(page, editDialog.getByRole("button", { name: "取消" }), "Enter");
  await expect(editDialog).toHaveCount(0);

  // 「一键提取」+ Enter：只发起一次提取（进度条出现）。
  const submit = page.getByTestId("extract-submit");
  expect(await pressOn(page, submit, "Enter"), "Enter 只触发一次点击").toBe(1);
  await expect(page.getByTestId("inline-progress")).toBeVisible({ timeout: 30_000 });
  // 等这次提取跑完：收尾要能删掉资源夹，运行中删除会被接口以 409 拒绝。
  await expect(page.getByTestId("inline-progress")).toHaveCount(0, { timeout: 120_000 });
});
