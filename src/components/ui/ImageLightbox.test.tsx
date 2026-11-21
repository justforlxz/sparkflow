// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ImageLightbox } from "./ImageLightbox";

/**
 * 站内图片预览（docs/prd/07-results.md「图片预览（全站统一）」）。
 *
 * 这里锁「弹窗里加载什么、怎么关、焦点回到哪」这三件事；三个关法各一条用例，
 * 因为它们分别会坏（`Esc` 监听、遮罩点击、关闭按钮）。
 */
afterEach(cleanup);

const IMAGE = {
  fileName: "1.png",
  url: "/api/files/generated/result-1/asset-1",
  thumbnailUrl: "/api/files/generated/result-1/asset-1?w=400",
};

function renderLightbox() {
  render(<ImageLightbox image={IMAGE} openLabel="查看大图" closeLabel="关闭" />);
  const trigger = screen.getByTestId("image-thumbnail");
  return { trigger };
}

describe("图片预览：缩略图是按钮，弹窗加载原图", () => {
  it("缩略图用缩略图地址，点击后在弹窗里加载原图地址并显示文件名", () => {
    const { trigger } = renderLightbox();

    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.querySelector("img")?.getAttribute("src")).toBe(IMAGE.thumbnailUrl);

    fireEvent.click(trigger);

    const lightbox = screen.getByTestId("image-lightbox");
    expect(lightbox).toBeTruthy();
    expect(screen.getByTestId("image-lightbox-image").getAttribute("src")).toBe(IMAGE.url);
    expect(screen.getByTestId("image-lightbox-filename").textContent).toBe(IMAGE.fileName);
  });

  it("没有弹窗时页面上不存在大图节点", () => {
    renderLightbox();
    expect(screen.queryByTestId("image-lightbox-image")).toBeNull();
  });
});

describe("图片预览：三种关法都把焦点还给缩略图", () => {
  it("关闭按钮", () => {
    const { trigger } = renderLightbox();
    fireEvent.click(trigger);

    fireEvent.click(screen.getByTestId("image-lightbox-close"));

    expect(screen.queryByTestId("image-lightbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("Esc 键", () => {
    const { trigger } = renderLightbox();
    fireEvent.click(trigger);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByTestId("image-lightbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("点遮罩关闭，点弹窗内不关闭", () => {
    const { trigger } = renderLightbox();
    fireEvent.click(trigger);

    fireEvent.click(screen.getByTestId("image-lightbox"));
    expect(screen.queryByTestId("image-lightbox")).not.toBeNull();

    fireEvent.click(screen.getByTestId("image-lightbox-overlay"));
    expect(screen.queryByTestId("image-lightbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
