/**
 * 通用交互样式（说明书：`docs/design/components.md`）。
 *
 * 为什么集中在这里：ADR 0007 要求「每个可点元素有 hover 与 focus-visible，禁用态不响应点击」，
 * 如果每个页面各写一份，四个状态迟早会漏。组件与页面都从这里取 class，
 * 漏了哪一态一眼能看出来，也让 `text-*` / `bg-*` 只出现设计变量（AC-D-1、AC-D-7）。
 * 焦点环不在这里：`globals.css` 的 `:focus-visible` 一条规则覆盖所有可聚焦元素（AC-D-5）。
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "warning";
export type ButtonSize = "md" | "sm";

/** 所有按钮共用的一层：布局、字重、过渡与禁用态。 */
const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  /* 主操作：深色实心，对比度最高，一屏只放一个。 */
  primary: "bg-ink text-on-inverse hover:bg-ink-secondary",
  /* 次操作：白底描边。 */
  secondary: "border border-control-border bg-panel text-ink hover:bg-soft",
  /* 第三级：无边框，放在卡片角上或用图标时用。 */
  ghost: "text-ink-secondary hover:bg-soft hover:text-ink",
  danger: "bg-danger text-on-inverse hover:bg-danger-strong",
  warning: "bg-warning text-on-inverse hover:bg-warning-strong",
};

/** 高度：36 / 28。都用 min-h，字号变大时按钮跟着长高，不被裁切。 */
const BUTTON_SIZES: Record<ButtonSize, string> = {
  md: "min-h-9 px-3.5 py-1.5 text-body",
  sm: "min-h-7 px-2.5 py-1 text-footnote",
};

export interface ButtonClassOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

/** 按钮、以及长得像按钮的链接（`<Link>`）共用。 */
export function buttonClass({
  variant = "secondary",
  size = "md",
  className,
}: ButtonClassOptions = {}): string {
  return [BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className ?? ""]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 输入框、下拉框、文本域共用的外观：白底 + 可见边框（≥3:1）+ 悬停加深 + 聚焦换色。
 * 表单错误提示统一用 `ErrorState`，不在输入框上另造一套红框。
 */
const CONTROL_BASE =
  "w-full rounded-md border border-control-border bg-panel px-3 text-body text-ink transition-colors placeholder:text-ink-tertiary hover:border-ink-tertiary disabled:cursor-not-allowed disabled:bg-soft disabled:text-ink-tertiary";

export const INPUT_CLASS = `${CONTROL_BASE} min-h-9 py-1.5`;
export const TEXTAREA_CLASS = `${CONTROL_BASE} py-2`;
/** 原生下拉：右侧留出浏览器箭头的空间。 */
export const SELECT_CLASS = `${CONTROL_BASE} min-h-9 py-1.5 pr-8`;
/** 勾选框 / 单选框：尺寸固定，选中色走 `accent-ink`，焦点环同样可见。 */
export const CHECKBOX_CLASS = "h-4 w-4 shrink-0 rounded-sm accent-ink";

/** 字段容器与标签：标签在上，提示在下，间距固定 6px。 */
export const FIELD_CLASS = "block space-y-1.5";
export const LABEL_CLASS = "block text-footnote font-medium text-ink-secondary";
export const HINT_CLASS = "block text-caption text-ink-tertiary";

/** 卡片里可点的整行（最近列表、发布记录这类「一行一条」的入口）。 */
export const CARD_LINK_CLASS =
  "flex items-center gap-3 rounded-md border border-line bg-panel p-2.5 transition-colors hover:border-line-strong hover:bg-soft";

/** 普通文字链接：下划线常驻，颜色只到次级，悬停升到正文色。 */
export const TEXT_LINK_CLASS =
  "rounded-sm text-ink-secondary underline underline-offset-2 transition-colors hover:text-ink";

/** 弹窗遮罩与面板：遮罩用设计变量的半透明色，面板与卡片同一档阴影。 */
export const OVERLAY_CLASS =
  "fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-overlay p-4 sm:p-6";
export const DIALOG_TITLE_CLASS = "text-heading font-semibold text-ink";

/** 弹窗宽度档位。基类不声明 `max-w-*`，宽度只能从这里选一档。 */
export type DialogWidth = "md" | "lg" | "xl" | "2xl";

const DIALOG_WIDTHS: Record<DialogWidth, string> = {
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
};

/**
 * 弹窗面板。宽度是必填的一档，不能由调用方再追加第二个 `max-w-*`。
 *
 * 原因：Tailwind 的同组工具类（这里都是 `max-width`）谁生效取决于生成样式表里的先后，
 * 不看类名书写的先后。基类若写死 `max-w-lg`，调用方再写 `max-w-2xl` 只会「有时生效」，
 * 就会退回成 512px。同理，这里的类只放调用方不会覆盖的属性（宽度、圆角、底色、阴影、内边距）。
 */
export function dialogClass(options: { width?: DialogWidth; className?: string } = {}): string {
  const { width = "lg", className } = options;
  return [
    "w-full space-y-4 rounded-lg bg-panel p-5 shadow-panel sm:p-6",
    DIALOG_WIDTHS[width],
    className ?? "",
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 行内提示条：正向 / 警告 / 危险三种语义，底色与文字成对使用。 */
export type NoticeTone = "positive" | "warning" | "danger";

const NOTICE_TONES: Record<NoticeTone, string> = {
  positive: "border-positive/25 bg-positive-soft text-positive",
  warning: "border-warning/25 bg-warning-soft text-warning",
  danger: "border-danger/25 bg-danger-soft text-danger",
};

export function noticeClass(tone: NoticeTone, className?: string): string {
  return ["break-words rounded-md border px-3 py-2 text-body", NOTICE_TONES[tone], className ?? ""]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 页面主标题的统一样式（工作台、资源夹、任务…）：一屏只有一个 h1，
 * 页码标题用 `text-title`，卡片标题用 `text-heading`，不再各页自选 Tailwind 默认字号。
 */
export const PAGE_TITLE_CLASS = "text-title font-semibold text-ink";
export const PAGE_SUBTITLE_CLASS = "text-body text-ink-secondary";
