"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { buttonClass, dialogClass, OVERLAY_CLASS } from "./styles";

/**
 * 站内图片预览（docs/prd/07-results.md「图片预览（全站统一）」）。
 *
 * 1. 缩略图本身是 `<button>`，不是 `<a>`，也不再打开新标签页（MUST 1、MUST 4）。
 * 2. 弹窗里加载的是**原图**地址 `url`，缩略图只用 `thumbnailUrl`；文件名在弹窗里可见（MUST 4）。
 * 3. 关闭按钮、`Esc`、点遮罩三种关法；关闭后焦点回到触发它的缩略图（MUST 3）。
 * 4. 文案（「查看大图」「关闭」）由调用方从各自模块常量传入，组件不写死业务字面量。
 */
export interface LightboxImage {
  fileName: string;
  /** 原图地址：弹窗里加载的就是它，不是缩略图地址。 */
  url: string;
  /** 网格里的缩略图地址（`?w=400`，docs/prd/07 SHOULD）。 */
  thumbnailUrl: string;
}

export interface ImageLightboxProps {
  image: LightboxImage;
  /** 缩略图的尺寸、圆角与悬停效果由调用方给：不同位置的格子大小不同。 */
  thumbnailClassName?: string;
  /** 缩略图的无障碍名称与悬停提示（「查看大图」）。 */
  openLabel: string;
  /** 弹窗里的关闭按钮文案。 */
  closeLabel: string;
}

export function ImageLightbox({
  image,
  thumbnailClassName,
  openLabel,
  closeLabel,
}: ImageLightboxProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  /** 三种关法共用：先收起弹窗，再把焦点还给触发它的缩略图（MUST 3）。 */
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    // 打开后焦点进弹窗：`Esc` 与 Tab 都在弹窗语义里，不会落到背后的页面。
    closeRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="image-thumbnail"
        aria-label={`${openLabel}：${image.fileName}`}
        title={openLabel}
        onClick={() => setOpen(true)}
        className="block w-full rounded-md"
      >
        {/* 鉴权路由读取缩略图，不走 Next 图片优化器。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.thumbnailUrl}
          alt={image.fileName}
          className={thumbnailClassName ?? "h-32 w-full rounded-md border border-line object-cover"}
        />
      </button>

      {open ? (
        <div className={OVERLAY_CLASS} data-testid="image-lightbox-overlay" onClick={close}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            data-testid="image-lightbox"
            className={dialogClass({ width: "2xl" })}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p
                id={titleId}
                data-testid="image-lightbox-filename"
                className="min-w-0 break-all text-body font-medium text-ink"
              >
                {image.fileName}
              </p>
              <button
                ref={closeRef}
                type="button"
                data-testid="image-lightbox-close"
                onClick={close}
                className={buttonClass({ variant: "secondary", size: "sm" })}
              >
                {closeLabel}
              </button>
            </div>

            {/* 大图用原图地址：长边像素大于网格里的缩略图（MUST 4）。 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              data-testid="image-lightbox-image"
              src={image.url}
              alt={image.fileName}
              className="max-h-[75vh] w-full rounded-md border border-line object-contain"
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
