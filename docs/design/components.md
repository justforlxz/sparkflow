# 通用组件与交互态

> 依据：`docs/adr/0007-界面重做保留骨架.md` ｜ 色板与字号：`docs/design/tokens.md`
>
> 所有交互元素的 class 来自 `src/components/ui/styles.ts`（按钮、输入框、卡片链接、提示条、弹窗）
> 或 `src/components/ui/*`（面板、标签、空/加载/错误态、轻提示、二次确认）。
> 页面里**不另写一套** hover / focus / disabled，四态在组件层一次定好（AC-D-7）。

## 0. 交互态的统一要求

| 状态 | 要求 |
| --- | --- |
| 默认 | 主色 `text-ink`；控件边框 `border-control-border`（≥3:1）；圆角按 `--radius-*` |
| hover | 底色或边框变一档（`bg-soft` / `border-line-strong` / `border-ink-tertiary`），150ms 过渡；不用缩放入场之类会晃动的效果 |
| focus-visible | 2px 焦点环 + 2px 偏移，颜色 `--focus`。由 `globals.css` 的 `:focus-visible` 一条全局规则给出，组件不用逐个写；鼠标点击不出现，键盘操作一定出现 |
| disabled | `disabled` 或 `aria-disabled="true"`；`cursor-not-allowed` + `opacity-45`；**不响应点击**；旁边必须有一句说明为什么不可用 |
| loading | 按钮文字换成进行中的说法（「保存中…」）并保持自身宽度；区块级加载用 `LoadingState` |
| 触控目标 | 按钮与输入框 `min-h-9`（36px）；侧栏导航 `min-h-10`（40px）；列表整行可点区域 ≥44px |

## 1. Button

`buttonClass({ variant, size })`

| 变体 | 外观 | 用在哪 | 禁用态 |
| --- | --- | --- | --- |
| `primary` | 深色实心（`bg-ink` + `text-on-inverse`），悬停 `bg-ink-secondary` | 一个视图里的唯一主动作：新建资源夹、开始创作、标记已发布、保存 | `disabled`，文案旁说明缺什么 |
| `secondary` | 白底 + 控件边框，悬停 `bg-soft` | 次操作：取消、编辑、测试连接、查看全部 | 同上 |
| `ghost` | 无边框，悬停 `bg-soft` | 卡片角上的轻量入口（「查看全部」） | 同 `secondary` |
| `danger` | 实心 `bg-danger`，悬停 `bg-danger-strong` | 删除确认按钮、删除资源夹 | 同上 |
| `warning` | 实心 `bg-warning`，悬停 `bg-warning-strong` | 重试失败的阶段、确认恢复默认 | 同上 |

尺寸：`md`（36px 高，正文 13px）用于表单与页头；`sm`（28px 高，12px 字）用于卡片内与列表行内的操作。

**长得像按钮的链接**（`<Link>`）用同一个 `buttonClass`，保证键盘焦点与悬停行为和按钮一致。

**禁止**：用 `outline-none` 抹掉焦点环（它会把 `--tw-outline-style` 置成 `none`，同元素上的 `focus-visible:outline-*` 会失效）；用 `cursor-pointer` 假装可点但元素不可聚焦。焦点环由全局规则统一给出，不需要每个组件再写。

## 2. 表单控件

| 控件 | class | 说明 |
| --- | --- | --- |
| 输入框 | `INPUT_CLASS` | 白底、控件边框、`min-h-9`；悬停边框加深；聚焦不换边框色，只由全局焦点环标出（避免鼠标点击也变边框） |
| 文本域 | `TEXTAREA_CLASS` | 同输入框，`py-2`，高度由 `rows` 决定 |
| 下拉框 | `SELECT_CLASS` | 原生 `<select>`，右侧留出箭头空间（`pr-8`） |
| 勾选框 | `CHECKBOX_CLASS` | 16px，选中色 `accent-ink`，焦点环可见 |
| 字段容器 | `FIELD_CLASS` | 标签在上、控件居中、提示在下，间距 6px |
| 字段标签 | `LABEL_CLASS` | 12px、`text-ink-secondary` |
| 字段提示 | `HINT_CLASS` | 11px、`text-ink-tertiary` |

表单错误统一用 `ErrorState`（`role="alert"`）显示在后端返回的位置，**不给输入框单独造红框**：
后端错误是「提交失败」而不是「这个字段格式不对」，红框会把用户引到错误的地方。
字段格式的错误由浏览器原生的 `required` / `type` 校验负责。

## 3. Panel（卡片）

`<Panel title description actions padded bodyClassName>`

- 外观固定：`rounded-lg`（14px）+ `border-line` + `bg-panel` + `shadow-panel`。
- 有 `title` / `description` / `actions` 时自动带一条 `border-b border-line` 的标题栏；标题 17px，描述 12px。
- `padded={false}` 用于图片卡片（图片贴边）；`bodyClassName` 补内容层布局。
- 列表项也用它，不再各自写 `rounded-lg border`。

## 4. Pill（状态标签）

`<Pill tone="draft|generating|pendingPublish|published|warning|danger|neutral">`

- 11px、`rounded-sm`、浅底 + 深字，颜色只来自 `--status-*` / 语义色变量。
- 状态到色板的映射只有 `src/components/ui/status-tone.ts` 一处；页面与组件不自己挑色。
- 标签**不接受**颜色字面值或 `className` 覆盖颜色（只允许补布局类）。

## 5. Dialog（弹窗）与二次确认

| 用途 | 组件 | 结构 |
| --- | --- | --- |
| 二次确认（删除、重新生成） | `ConfirmDialog` | `OVERLAY_CLASS` + `dialogClass({ width: "md" })` + 标题 + 说明 + 取消/确认 |
| 业务弹窗（新建/编辑资源夹、开始创作、编辑结果、发布准备、网关） | 页面内客户端组件 | 同上三层，标题 `DIALOG_TITLE_CLASS`，宽度从 `md` / `lg` / `xl` / `2xl` 里按内容选一档：编辑结果与开始创作 `lg`、网关 `xl`、资源夹与发布准备 `2xl` |

- 遮罩 `bg-overlay`，面板 `bg-panel` + `shadow-panel`，不出现第二种阴影。
- **基类不得声明调用方要覆盖的属性**：Tailwind 的同组工具类（例如都是 `max-width`）谁生效取决于生成
  样式表里的先后，不看类名书写的先后。所以 `dialogClass` 把宽度做成必选档位，调用方不能再追加第二个
  `max-w-*`；同一原则适用于 `noticeClass`（内边距固定为基类那一档，调用方只补排版类）。
- 取消按钮一律 `secondary`，确认按钮按语义取 `primary` / `danger` / `warning`。
- 危险操作必须在标题或说明里写清「不可恢复」或「会产生新任务」。
- 弹窗打开时会话不变：提交中把按钮 `disabled` 并把文案换成进行中的说法；失败在弹窗内用 `ErrorState` 展示，不关窗。

## 6. 提示条与轻提示

| 形态 | 调用 | 语义 | 何时用 |
| --- | --- | --- | --- |
| 行内提示条 | `noticeClass("positive" \| "warning" \| "danger")` | 正向 / 警告 / 危险 | 结果页的水印提示、文案阶段失败摘要、快照变更提示、删除确认区 |
| 错误块 | `<ErrorState message action />` | 危险（`role="alert"`） | 接口失败、表单提交失败 |
| 轻提示 | `useToast().show(message, tone)` | `info` / `success` / `danger` | 操作成功后的全局反馈（已保存、已标记发布） |

文案只显示后端 `error.message` 或模块常量里的句子，不拼状态码、不贴上游原始回包。

## 7. 空态 / 加载 / 错误

| 组件 | 要求 |
| --- | --- |
| `EmptyState` | 虚线边框 + 白底；一句说明「现在没有什么」；可选一句引导与一个动作。不得放演示数字或占位图片 |
| `LoadingState` | `role="status"`；只在「这块还没有可显示数据」时出现，不盖在已有内容上 |
| `ErrorState` | `role="alert"`；只显示后端 `error.message`；需要重试时用 `action` 传入按钮 |

## 8. 导航、页签与列表行

- **侧栏导航**（`AppNav`）：图标 + 文字；当前项 `bg-accent-strong` + `text-on-inverse`；非当前项 `text-ink-secondary`，悬停 `bg-soft`；计数徽标 `rounded-sm` 小标签；窄屏（<720px）只留图标，`aria-label` 保留完整名字。
- **页签**（资源夹详情的三个页签）：选中项底部 2px `border-accent` + `text-ink` 加粗（下划线是图形，3.55:1 够 3:1）；未选中 `text-ink-secondary`，悬停升到 `text-ink`；键盘焦点有焦点环。
- **整块可点的卡片链接**：`CARD_LINK_CLASS`（带内边距与悬停底色）；图片卡这类外层带 `overflow-hidden` 的整块链接加 `focus-visible:outline-offset-0`，把焦点环收进内部，避免被裁掉。
- **普通文字链接**：`TEXT_LINK_CLASS`，下划线常驻、`text-ink-secondary`，悬停升到 `text-ink`。

## 9. 标题层级

| 位置 | class |
| --- | --- |
| 页面主标题（h1） | `PAGE_TITLE_CLASS`（22 / 28，semibold） |
| 页面副标题 | `PAGE_SUBTITLE_CLASS`（13 / 18，`text-ink-secondary`） |
| 区块标题（h2/h3） | `text-heading`（17 / 22，semibold） |
| 卡片标题（h3/h4） | `text-body-lg` 或 `text-heading`，semibold |

## 10. 明确禁止

- 写颜色字面值（`#ef4d63`、`rgb(...)`）或 Tailwind 默认色阶（`zinc-*`、`gray-*`、`red-*`、`amber-*`、`emerald-*`）。
- 写默认字号阶梯（`text-xs` / `text-sm` / `text-base` / `text-lg` / `text-2xl`），一律用 `docs/design/tokens.md` 第 2 节的阶梯。
- 使用 `shadow-sm` / `shadow-md` / `shadow-lg` / `shadow-xl`，阴影只有 `shadow-panel` 一档。
- 引入组件库或图标库；图标继续是内联 SVG。
- 为单个页面新造一套按钮 / 输入框 / 卡片外观；缺能力时先补 `styles.ts` 与本文档。
