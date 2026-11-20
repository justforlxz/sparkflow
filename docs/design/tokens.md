# 设计变量（tokens）

> 依据：`docs/adr/0007-界面重做保留骨架.md` ｜ 实现：`src/app/globals.css`
>
> - 颜色、字号、圆角、阴影的字面值**只**写在 `globals.css` 里；页面与组件只用 `@theme inline`
>   映射出来的 class（`bg-panel`、`text-ink`、`border-line`、`bg-soft`、`text-accent`…）。
> - 不使用 Tailwind 默认色阶（`zinc-*` / `gray-*` / `slate-*` / `red-*` / `amber-*` / `emerald-*` 等）。
> - 本文件的变量名与 `globals.css` 一一对应，`src/components/ui/design-tokens.test.ts` 会逐条比对（AC-D-2），
>   并把下面「对比度实测」一节的比值重新算一遍（AC-D-6）。

## 1. 颜色

class 名由 `@theme inline` 的 `--color-<变量名>` 生成：`--color-panel` → `bg-panel` / `text-panel` /
`border-panel`。所以下表「变量」一栏既是 CSS 变量，也是 class 名的来源。

### 1.1 表面

| 变量 | 值 | class | 用途 |
| --- | --- | --- | --- |
| `--bg` | `#f6f7f9` | `bg-bg` | 页面底色，只有 `body` 与登录页外层用它 |
| `--panel` | `#ffffff` | `bg-panel` | 卡片、面板、下拉、弹窗的底色 |
| `--soft` | `#eef0f4` | `bg-soft` | 次级填充：悬停底、标签底、缩略图占位、侧栏计数底 |
| `--line` | `#e2e5ea` | `border-line` | 装饰性分隔线（卡片头、表格行、列表项） |
| `--line-strong` | `#c9ced6` | `border-line-strong` | 需要一点强调的边框：空状态虚线框、卡片悬停边框 |
| `--control-border` | `#7f8794` | `border-control-border` | 控件边框：输入框、下拉框、次操作按钮。承担「这是一个控件」的识别，按 ≥3:1 取值 |
| `--overlay` | `rgb(16 18 22 / 45%)` | `bg-overlay` | 弹窗遮罩 |

### 1.2 文字

| 变量 | 值 | class | 用途 |
| --- | --- | --- | --- |
| `--ink` | `#16181d` | `text-ink` | 正文与标题的主色 |
| `--ink-secondary` | `#4c525c` | `text-ink-secondary` | 次级正文：说明文字、表单标签、摘要 |
| `--ink-tertiary` | `#616874` | `text-ink-tertiary` | 第三级：时间、计数、提示、占位符 |
| `--on-inverse` | `#ffffff` | `text-on-inverse` | 深色/高饱和填充上的文字（实心按钮、侧栏当前项） |

### 1.3 强调、焦点与语义色

| 变量 | 值 | class | 用途 |
| --- | --- | --- | --- |
| `--accent` | `#ef4d63` | `text-accent` / `bg-accent` | 品牌强调：只用于图形与大面积色块（3.55:1，够 3:1，不够正文 4.5:1） |
| `--accent-strong` | `#c11f3a` | `text-accent-strong` / `bg-accent-strong` | 需要承载文字的强调：侧栏当前项、标签页选中下划线、选中的图片边框 |
| `--focus` | `#1a6dff` | `outline-focus` / `ring-focus` | 键盘焦点环，2px + 2px 偏移 |
| `--positive` | `#15803d` | `text-positive` / `bg-positive` | 正向结果：保存成功、复制成功 |
| `--positive-soft` | `#dcfce7` | `bg-positive-soft` | 正向提示条的底色 |
| `--warning` | `#92400e` | `text-warning` / `bg-warning` | 警告文字与警告实心按钮 |
| `--warning-soft` | `#fef3c7` | `bg-warning-soft` | 警告提示条的底色（水印提示、失败摘要、快照变更提示） |
| `--warning-strong` | `#7c2d12` | `bg-warning-strong` | 警告按钮悬停 |
| `--danger` | `#b91c1c` | `text-danger` / `bg-danger` | 错误文字与危险实心按钮 |
| `--danger-soft` | `#fee2e2` | `bg-danger-soft` | 错误提示条的底色 |
| `--danger-strong` | `#991b1b` | `bg-danger-strong` | 危险按钮悬停 |

### 1.4 业务状态色（语义固定）

`docs/prd/09-dashboard.md` SHOULD：待创作=蓝、生成中=强调色、待发布=橙、已发布=绿。
取值沿用第一版交付时定的色值：生成中当前是紫色（`#6d28d9`），与 PRD 的「强调色」措辞不一致；
本次只做视觉重做、不改需求，这一处偏离留给功能检测判定。
状态到色板的映射只有一处：`src/components/ui/status-tone.ts`。

| 变量 | 值 | class | 状态 |
| --- | --- | --- | --- |
| `--status-draft` | `#1d4ed8` | `text-status-draft` | 待创作（资源夹 `draft`） |
| `--status-draft-soft` | `#dbeafe` | `bg-status-draft-soft` | 同上，标签底色 |
| `--status-generating` | `#6d28d9` | `text-status-generating` | 生成中（资源夹 `generating`、任务/阶段 `running`） |
| `--status-generating-soft` | `#ede9fe` | `bg-status-generating-soft` | 同上，标签底色 |
| `--status-pending-publish` | `#c2410c` | `text-status-pending-publish` | 待发布（资源夹 `has_results`、任务 `partial`） |
| `--status-pending-publish-soft` | `#ffedd5` | `bg-status-pending-publish-soft` | 同上，标签底色 |
| `--status-published` | `var(--positive)` | `text-status-published` | 已发布（资源夹 `published`、任务 `succeeded`） |
| `--status-published-soft` | `var(--positive-soft)` | `bg-status-published-soft` | 同上，标签底色 |

> `--status-published` 与 `--positive` 共用一份色值：界面上「正向结果」和「已发布」是同一个视觉语义，
> 但变量分开命名，将来要拆时不影响调用方。

## 2. 字号阶梯

11 / 12 / 13 / 15 / 17 / 22 / 28。行高随字号一起定，页面**不再**写 `text-xs` / `text-sm` / `text-2xl` 这类默认值。

| 变量 | 字号 / 行高 | class | 用途 |
| --- | --- | --- | --- |
| `--text-caption` | 11 / 14 | `text-caption` | 极小标注：图片角标、计数单位 |
| `--text-footnote` | 12 / 16 | `text-footnote` | 辅助信息：时间、元数据、字段标签、提示 |
| `--text-body` | 13 / 18 | `text-body` | 正文默认值（表格、列表、按钮、输入框） |
| `--text-body-lg` | 15 / 20 | `text-body-lg` | 稍大的正文：弹窗内的小节标题 |
| `--text-heading` | 17 / 22 | `text-heading` | 区块标题（h2 / h3） |
| `--text-title` | 22 / 28 | `text-title` | 页面主标题（h1） |
| `--text-display` | 28 / 34 | `text-display` | 只给登录页主标题与统计数字 |

## 3. 间距

沿用 4px 基准刻度，只用这几档：`1`(4) / `1.5`(6) / `2`(8) / `2.5`(10) / `3`(12) / `4`(16) / `5`(20) / `6`(24) / `8`(32) / `10`(40) / `12`(48)。
同一组元素内部的间距只用一个档位；卡片内容与边框之间固定 `p-4`。

## 4. 圆角

| 变量 | 值 | class | 用途 |
| --- | --- | --- | --- |
| `--radius-sm` | 6px | `rounded-sm` | 状态标签、计数徽标、代码片段 |
| `--radius-md` | 10px | `rounded-md` | 按钮、输入框、下拉框、缩略图 |
| `--radius-lg` | 14px | `rounded-lg` | 卡片、面板、弹窗 |

## 5. 阴影

只有一档，卡片与弹窗共用；不使用 `shadow-sm` / `shadow-md` / `shadow-xl`。

| 变量 | 值 | class | 用途 |
| --- | --- | --- | --- |
| `--shadow-panel` | `0 1px 2px rgb(16 18 22 / 6%), 0 1px 3px rgb(16 18 22 / 4%)` | `shadow-panel` | 所有卡片、面板、弹窗、轻提示 |

## 6. 动效

只做过属性（颜色、背景、边框、透明度）的过渡；不做装饰动画，不做位移动画。

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `--default-transition-duration` | `150ms` | `transition-colors` 的默认时长 |
| `--default-transition-timing-function` | `cubic-bezier(0.2, 0, 0, 1)` | 默认缓动 |

唯一的持续动画是加载态的转圈（`animate-spin`），它是状态指示，不是装饰。

## 7. 对比度实测

WCAG 2.x 公式计算。正文要求 ≥4.5:1，大字号与控件边界要求 ≥3:1（AC-D-6）。

| 组合 | 比值 | 判定 |
| --- | --- | --- |
| `--ink` / `--panel` | 17.76 | ✅ 正文 |
| `--ink` / `--soft` | 15.57 | ✅ 正文 |
| `--ink-secondary` / `--panel` | 7.87 | ✅ 正文 |
| `--ink-secondary` / `--soft` | 6.90 | ✅ 正文 |
| `--ink-tertiary` / `--panel` | 5.61 | ✅ 正文 |
| `--ink-tertiary` / `--soft` | 4.92 | ✅ 正文 |
| `--on-inverse` / `--ink` | 17.76 | ✅ 正文 |
| `--on-inverse` / `--accent-strong` | 5.96 | ✅ 正文 |
| `--on-inverse` / `--danger` | 6.47 | ✅ 正文 |
| `--on-inverse` / `--warning` | 7.09 | ✅ 正文 |
| `--accent-strong` / `--panel` | 5.96 | ✅ 正文 |
| `--focus` / `--panel` | 4.49 | ✅ 控件（要求 3:1） |
| `--focus` / `--bg` | 4.19 | ✅ 控件 |
| `--control-border` / `--panel` | 3.62 | ✅ 控件边框 |
| `--control-border` / `--bg` | 3.38 | ✅ 控件边框 |
| `--accent` / `--panel` | 3.55 | ✅ 大字号与图形（不能承载正文） |
| `--danger` / `--danger-soft` | 5.30 | ✅ 正文 |
| `--warning` / `--warning-soft` | 6.37 | ✅ 正文 |
| `--positive` / `--positive-soft` | 4.57 | ✅ 正文 |
| `--status-draft` / `--status-draft-soft` | 5.49 | ✅ 正文 |
| `--status-generating` / `--status-generating-soft` | 5.98 | ✅ 正文 |
| `--status-pending-publish` / `--status-pending-publish-soft` | 4.52 | ✅ 正文 |
| `--status-published` / `--status-published-soft` | 4.57 | ✅ 正文 |
| `--line` / `--panel` | 1.26 | 装饰性分隔线，不承担控件识别，不参与判定 |
| `--line-strong` / `--panel` | 1.58 | 同上（空状态虚线框的边界由文案承担识别） |
