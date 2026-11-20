# 10 功能开关（Feature Flags）

> 依赖：无（属于架构基线）｜ 被 04、05、08 引用

## 目标

按功能粒度控制「这个版本能不能用」。判定只有一个入口，界面、接口、任务执行都读同一个值；
不允许在任何调用点自行判断功能是否存在。

## 为什么不用散落的 if

第一版有两个「界面保留、能力不做」的功能：图生图、分享。若在调用点写
`if (!implemented) return`，会出现：口径散落（改一处漏一处）、接口可被绕过、
下一版打开时要全库搜索。开关做成机制后，这些都不存在。

## 设计契约

### 三层结构

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 注册表 | `src/modules/feature-flags/registry.ts`（代码常量） | 声明有哪些开关：key、名称、说明、默认值、是否已实现 |
| 持久化 | 表 `feature_flag`（key 主键、enabled、updated_at） | 保存当前取值；缺行时取注册表默认值 |
| 判定入口 | 服务端 `isEnabled(key)` / `requireEnabled(key)`；界面 `<FeatureGate>` / `useFeature(key)` | 唯一判定与唯一展示 |

### 生效规则

```
实际可用 = 注册表.implemented && (数据库.enabled ?? 注册表.defaultEnabled)
```

`implemented = false` 的功能**永远不可用**，即使有人直接改数据库把 `enabled` 写成 true。
这一条让「架构层面控制」可被测试断言，而不是靠约定。

### MUST

1. 新增一个开关只允许改注册表 + 提交一条迁移（可选，用于预置默认值），不得在业务代码里加判断。
2. 所有与功能可用性相关的接口，在入口处调用 `requireEnabled(key)`；不满足时返回
   `FEATURE_DISABLED`（HTTP 409，`details.feature = key`），**不执行任何副作用**。
3. 所有与功能可用性相关的界面入口，用 `<FeatureGate feature="...">` 包裹；
   关闭状态下点击提示「该功能未启用」，且**不发起网络请求**、不改变任何状态。
4. 设置页必须有「功能开关」区块：列出注册表全部项（名称、说明、当前状态、是否已实现），
   开关直接读写 `feature_flag` 表。
5. 对 `implemented = false` 的项，开关显示为不可操作并标注「本版本未实现」；
   `PATCH /api/features/[key]` 开启未实现项时返回 `FEATURE_NOT_IMPLEMENTED`（400）。
6. 开关变更立即生效（不做进程内缓存，或缓存必须带失效）；任务执行时按**执行时**的值判定，
   不读任务创建时的快照。

### SHOULD

- 开关列表在设置页按「可用 / 本版本未实现」分组。
- 注册表每项写明 `affects`（受影响的界面与接口路径），便于验收逐条核对。

### MUST NOT

- 不得在业务代码里写 `if (flag === "image-to-image")` 之类的具体判断。
- 不得用环境变量代替开关（部署期无法改，且与「配置在库里」冲突）。
- 不得把开关用于 A/B 测试或按用户分流（本项目只有单用户）。
- 不得在功能关闭时仍然让接口产生数据（例如先建任务再报错）。

## 第一版注册表

| key | 名称 | implemented | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `image-to-image` | 图生图（参考原图生成） | **true** | 开启 | 每张原图各生成一张成品图（ADR 0008）。2026-11-19 起已实现 |
| `share-to-xiaohongshu` | 分享到小红书 | false | 关闭 | 对外发布动作。本版本不实现，点击提示「分享功能不可用」 |

## 数据与接口

`feature_flag`：key（主键，字符串）、enabled（布尔）、updated_at

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/features` | 注册表 + 当前生效值 + 是否已实现 |
| PATCH | `/api/features/[key]` | 设置开关；未实现项返回 `FEATURE_NOT_IMPLEMENTED` |

## 验收标准

| 编号 | 断言 | 自动化用例 |
| --- | --- | --- |
| AC-10-1 | `GET /api/features` 返回两个注册项，状态与数据库一致 | `tests/e2e/features.spec.ts` |
| AC-10-2 | 对未实现项调用 `PATCH` 开启，返回 `FEATURE_NOT_IMPLEMENTED`，数据库值不变 | 同上 |
| AC-10-3 | 直接把数据库里仍未实现的 `share-to-xiaohongshu.enabled` 改成 true 后，相关接口仍返回 `FEATURE_DISABLED`（`implemented = false` 的功能永远不可用） | 单测（绕过 UI 直接改库） |
| AC-10-4 | 图生图开启后，界面入口可用；把开关关掉时入口回到禁用态且不发起请求（双向验证） | e2e（监听 request） |
| AC-10-5 | 分享关闭时，点击「分享到小红书」出现「分享功能不可用」，且没有新窗口、没有网络请求 | e2e |
| AC-10-6 | 设置页的功能开关区块能显示两项、显示「本版本未实现」，且开关不可操作 | e2e |
| AC-10-7 | 新增一个开关只需要改注册表文件（评审时以「业务代码无新增判断」为通过条件） | 人工评审 |

## 验证方式

```bash
pnpm test        # 生效规则（implemented && enabled）、绕过数据库直改的拦截
pnpm test:e2e    # tests/e2e/features.spec.ts
```
