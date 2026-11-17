// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FeatureGateFallback } from "./FeatureGateFallback";

afterEach(cleanup);

describe("功能关闭时的入口占位", () => {
  it("默认只显示禁用态按钮与已定文案，不显示提示", () => {
    render(<FeatureGateFallback label="分享到小红书" message="分享功能不可用" />);

    const button = screen.getByRole("button", { name: "分享到小红书" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("点击后显示注册表里的提示文案", () => {
    render(<FeatureGateFallback label="分享到小红书" message="分享功能不可用" />);

    fireEvent.click(screen.getByRole("button", { name: "分享到小红书" }));

    expect(screen.getByRole("status").textContent).toBe("分享功能不可用");
  });
});
