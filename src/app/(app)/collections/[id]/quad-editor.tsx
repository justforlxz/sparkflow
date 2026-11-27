"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { fetchJson } from "@/components/api";
import { ErrorState } from "@/components/ui/ErrorState";
import { Pill } from "@/components/ui/Pill";
import {
  buttonClass,
  CHECKBOX_CLASS,
  dialogClass,
  DIALOG_TITLE_CLASS,
  FIELD_CLASS,
  HINT_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  OVERLAY_CLASS,
} from "@/components/ui/styles";
import { QUAD_COPY } from "@/modules/media-collection/constants";
import {
  defaultQuad,
  isValidQuad,
  parseQuad,
  QUAD_KIND_LABELS,
  QUAD_KINDS,
  resolveAspectRatio,
  toQuadPoints,
  type NormalizedQuad,
  type QuadKind,
} from "@/modules/media-collection/quad";

/**
 * 四角框选编辑器（MKACG-1001「交互（前端）」）。
 *
 * 原图铺满编辑区，四个可拖动的手柄默认放在图片四角内缩 10%；
 * 拖动时实时画出四边形，并在无法保存时给出可读提示（AC-QUAD-4）。
 * 保存走 `PUT /api/library/assets/[id]/quad`，后端同步生成矫正图。
 *
 * 三点刻意保留：
 * 1. 手柄是 `<button>`，方向键每次移动 1% 图片、按住 Shift 移动 10% —— 鼠标拖不准时还有键盘；
 * 2. 长宽比与「比例未能估算」的判定直接复用后端那组纯函数（`resolveAspectRatio` 里的
 *    `estimateAspectRatio`），不在这里另写一套近似，否则界面说的话和后端算的事会不一致；
 * 3. 手输实际尺寸**优先**于估算（AC-QUAD-6），冲突时以输入为准。
 */
export interface QuadEditorProps {
  assetId: string;
  /** 原图地址：编辑器里铺的就是它（鉴权路由，不用缩略图）。 */
  imageUrl: string;
  fileName: string;
  /** 已保存的四角；未框选为 null。 */
  quad: unknown;
  quadKind: QuadKind | null;
  realSize: { width: number; height: number } | null;
  onSaved(): void;
}

/** 归一化坐标的钳制：手柄只在图上，拖出边界处按边界算。 */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 从库里的 jsonb 读回四点；读不出来就从默认四角开始。 */
function initialQuad(quad: unknown): NormalizedQuad {
  return parseQuad(quad) ?? defaultQuad();
}

export function QuadEditor({
  assetId,
  imageUrl,
  fileName,
  quad,
  quadKind,
  realSize,
  onSaved,
}: QuadEditorProps) {
  const [open, setOpen] = useState(false);
  const [points, setPoints] = useState<NormalizedQuad>(() => initialQuad(quad));
  const [kind, setKind] = useState<QuadKind>(quadKind ?? "surface");
  const [widthInput, setWidthInput] = useState(realSize ? String(realSize.width) : "");
  const [heightInput, setHeightInput] = useState(realSize ? String(realSize.height) : "");
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rectifyWarning, setRectifyWarning] = useState<string | null>(null);

  const boxRef = useRef<HTMLDivElement>(null);
  const dialogTitleId = useId();

  /** 打开时回到库里那一份：上一次没保存的拖动不该留下来。 */
  const openDialog = useCallback(() => {
    setPoints(initialQuad(quad));
    setKind(quadKind ?? "surface");
    setWidthInput(realSize ? String(realSize.width) : "");
    setHeightInput(realSize ? String(realSize.height) : "");
    setError(null);
    setRectifyWarning(null);
    setOpen(true);
  }, [quad, quadKind, realSize]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  /** 拖动一个手柄：坐标按图片盒子的比例归一化，拖到盒子外按边界算。 */
  useEffect(() => {
    if (dragging === null) return;

    function move(event: PointerEvent): void {
      const box = boxRef.current?.getBoundingClientRect();
      if (!box || box.width === 0 || box.height === 0) return;
      const x = clamp01((event.clientX - box.left) / box.width);
      const y = clamp01((event.clientY - box.top) / box.height);
      setPoints(
        (current) =>
          current.map((point, index) => (index === dragging ? { x, y } : point)) as unknown as
            NormalizedQuad,
      );
    }

    function stop(): void {
      setDragging(null);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging]);

  function moveHandle(index: number, dx: number, dy: number): void {
    setPoints(
      (current) =>
        current.map((point, position) =>
          position === index
            ? { x: clamp01(point.x + dx), y: clamp01(point.y + dy) }
            : point,
        ) as unknown as NormalizedQuad,
    );
  }

  function onHandleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    // 方向键细调，按住 Shift 一次走 10%：鼠标拖不准时还能用键盘对齐。
    const step = event.shiftKey ? 0.1 : 0.01;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    moveHandle(index, delta[0], delta[1]);
  }

  const manualWidth = Number.parseInt(widthInput, 10);
  const manualHeight = Number.parseInt(heightInput, 10);
  const manualSize =
    Number.isInteger(manualWidth) && manualWidth > 0 && Number.isInteger(manualHeight) && manualHeight > 0
      ? { width: manualWidth, height: manualHeight }
      : null;

  const valid = isValidQuad(points);
  // 与后端同一份判定：估算失败、手输优先都在 `resolveAspectRatio` 里（AC-QUAD-5、AC-QUAD-6）。
  const resolved = resolveAspectRatio({
    quad: points,
    imageWidth: imageSize?.width ?? 1,
    imageHeight: imageSize?.height ?? 1,
    realSize: manualSize,
  });
  const lowResolution =
    imageSize !== null &&
    Math.max(imageSize.width, imageSize.height) < QUAD_COPY.lowResolutionEdge;

  async function save(): Promise<void> {
    if (!valid) return;
    setSaving(true);
    setError(null);
    setRectifyWarning(null);
    try {
      const result = await fetchJson<{ rectifiedError: string | null }>(
        `/api/library/assets/${assetId}/quad`,
        {
          method: "PUT",
          body: JSON.stringify({
            kind,
            points: toQuadPoints(points),
            realSize: manualSize,
          }),
        },
      );
      if (result.rectifiedError) {
        setRectifyWarning(QUAD_COPY.rectifyFailed(result.rectifiedError));
      } else {
        setOpen(false);
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : QUAD_COPY.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  async function clear(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await fetchJson<{ id: string }>(`/api/library/assets/${assetId}/quad`, { method: "DELETE" });
      setOpen(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : QUAD_COPY.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="asset-quad-open"
        data-asset-id={assetId}
        onClick={openDialog}
        className={buttonClass({ variant: "ghost", size: "sm", className: "px-1.5" })}
      >
        {QUAD_COPY.openAction}
      </button>

      {open ? (
        <div className={OVERLAY_CLASS}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
            data-testid="quad-editor"
            className={dialogClass({ width: "2xl" })}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h2 id={dialogTitleId} className={DIALOG_TITLE_CLASS}>
                {QUAD_COPY.dialogTitle}
              </h2>
              <button
                type="button"
                data-testid="quad-editor-close"
                onClick={() => setOpen(false)}
                className={buttonClass({ variant: "secondary", size: "sm" })}
              >
                {QUAD_COPY.closeAction}
              </button>
            </div>
            <p className="break-all text-caption text-ink-tertiary">{fileName}</p>
            <p className="text-body text-ink-secondary">{QUAD_COPY.intro}</p>

            {/* 图片盒子：手柄与四边形都按它的比例定位，所以它必须紧贴图片本身。 */}
            <div
              ref={boxRef}
              data-testid="quad-editor-box"
              className="relative w-full select-none overflow-hidden rounded-md border border-line bg-soft"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- 鉴权路由，不走 Next 图片优化器 */}
              <img
                src={imageUrl}
                alt={fileName}
                className="block h-auto w-full"
                onLoad={(event) => {
                  const image = event.currentTarget;
                  setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
                }}
              />

              <svg
                aria-hidden
                className="pointer-events-none absolute inset-0 h-full w-full"
                viewBox="0 0 1 1"
                preserveAspectRatio="none"
              >
                <polygon
                  data-testid="quad-editor-polygon"
                  points={points.map((point) => `${point.x},${point.y}`).join(" ")}
                  fill="rgba(0,0,0,0.08)"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                  className="text-ink"
                />
              </svg>

              {points.map((point, index) => (
                <button
                  key={index}
                  type="button"
                  data-testid="quad-editor-handle"
                  data-index={index}
                  aria-label={`第 ${index + 1} 个角`}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    setDragging(index);
                  }}
                  onKeyDown={(event) => onHandleKeyDown(event, index)}
                  style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                  className="absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-full border-2 border-panel bg-ink shadow-panel active:cursor-grabbing"
                />
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span data-testid="quad-aspect" className="text-body text-ink-secondary">
                {QUAD_COPY.aspectLabel}：
                {resolved.source === "fallback" && !manualSize
                  ? QUAD_COPY.aspectUnknown
                  : `${QUAD_COPY.aspectValue(resolved.ratio)}（${
                      resolved.source === "manual"
                        ? QUAD_COPY.aspectFromManual
                        : QUAD_COPY.aspectFromEstimate
                    }）`}
              </span>
              {lowResolution ? (
                <Pill data-testid="quad-low-resolution" tone="warning">
                  {QUAD_COPY.lowResolution}
                </Pill>
              ) : null}
            </div>

            <fieldset className="space-y-1.5">
              <legend className={LABEL_CLASS}>{QUAD_COPY.kindLegend}</legend>
              <div className="flex flex-wrap gap-3">
                {QUAD_KINDS.map((value) => (
                  <label key={value} className="flex items-center gap-2 text-body text-ink">
                    <input
                      type="radio"
                      name={`quad-kind-${assetId}`}
                      data-testid="quad-kind"
                      value={value}
                      className={CHECKBOX_CLASS}
                      checked={kind === value}
                      onChange={() => setKind(value)}
                    />
                    {QUAD_KIND_LABELS[value]}
                  </label>
                ))}
              </div>
              <p className={HINT_CLASS}>{QUAD_COPY.kindHint}</p>
            </fieldset>

            <fieldset className="space-y-1.5">
              <legend className={LABEL_CLASS}>{QUAD_COPY.realSizeLegend}</legend>
              <div className="flex flex-wrap items-end gap-2">
                <label className={FIELD_CLASS}>
                  <span className={HINT_CLASS}>{QUAD_COPY.realSizeWidthLabel}</span>
                  <input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    data-testid="quad-real-width"
                    className={INPUT_CLASS}
                    value={widthInput}
                    onChange={(event) => setWidthInput(event.target.value)}
                  />
                </label>
                <label className={FIELD_CLASS}>
                  <span className={HINT_CLASS}>{QUAD_COPY.realSizeHeightLabel}</span>
                  <input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    data-testid="quad-real-height"
                    className={INPUT_CLASS}
                    value={heightInput}
                    onChange={(event) => setHeightInput(event.target.value)}
                  />
                </label>
              </div>
              <p className={HINT_CLASS}>{QUAD_COPY.realSizeHint}</p>
            </fieldset>

            {valid ? null : (
              <p data-testid="quad-invalid" className="text-body text-danger">
                {QUAD_COPY.invalidQuad}
              </p>
            )}
            {rectifyWarning ? (
              <p data-testid="quad-rectify-warning" className="text-body text-warning">
                {rectifyWarning}
              </p>
            ) : null}
            {error ? <ErrorState message={error} /> : null}

            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                data-testid="quad-reset"
                onClick={() => setPoints(defaultQuad())}
                className={buttonClass({ variant: "secondary" })}
              >
                {QUAD_COPY.resetAction}
              </button>
              <button
                type="button"
                data-testid="quad-clear"
                onClick={() => void clear()}
                disabled={saving || quadKind === null}
                className={buttonClass({ variant: "ghost" })}
              >
                {QUAD_COPY.clearAction}
              </button>
              <button
                type="button"
                data-testid="quad-save"
                onClick={() => void save()}
                // 凹四边形与自交四边形在这里被禁用，配合下方提示（AC-QUAD-4）。
                disabled={!valid || saving}
                className={buttonClass({ variant: "primary" })}
              >
                {saving ? QUAD_COPY.savingAction : QUAD_COPY.saveAction}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
