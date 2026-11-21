# 12 素材库、提取运行与文案版本

> 依赖：01 资源夹、02 网关、03 Agent、05 提取、06 文案、10 功能开关
> 取代：04 里「一条任务两阶段」的编排与 07 里「结果卡片」的结构（ADR 0010）

## 目标

把「提取」与「写文案」拆成两个独立动作：先把原图加工成按类别组织的素材，进素材库；
再从素材库里挑图、生成文案，每次生成留一个可回看的版本。发布仍是用户手动标记。

## 概念

| 概念 | 含义 |
| --- | --- |
| 提取运行（Extraction Run） | 一次「AI 处理」：选中的原图 × 选中的类别，产出若干素材 |
| 素材（Library Asset） | 素材库里的一张产物，带类别（材质纹理 / 边框样式 / 其他）与来源原图 |
| 文案版本（Copy Version） | 一次「生成文案」的产物：标题、正文、标签，以及当时选中的素材清单 |

## 数据模型

```
extraction_run
  id, collection_id,
  status: queued | running | succeeded | partial | failed,
  requirement: faithful | flatten | dereflect,
  categories: text[]   -- material | border | other
  source_asset_ids: text[]  -- 本次参与提取的原图
  progress: jsonb      -- { done, total }，按 原图×类别 计
  error: jsonb, extra_prompt: text, created_at, finished_at

library_asset
  id, collection_id, extraction_run_id, source_asset_id,
  category: material | border | other,
  storage_key, file_name, mime_type, width, height, sort_order, created_at

copy_version
  id, collection_id, version_no (资源夹内唯一递增),
  title, body, tags: text[],
  copy_style, agent_snapshot: jsonb,
  selected_asset_ids: text[],   -- 本版用了哪几张素材
  created_at

publish_record
  id, copy_version_id (唯一), platform, published_at,
  title_snapshot, selected_asset_ids: text[], created_at, updated_at
```

## 设计契约

### MUST

1. **两个动作互不依赖地可重跑**：提取可以反复跑（同一张原图同一类别可产出多个素材，都留在库里）；
   文案可以反复生成（每次一个新版本）。跑文案不触发提取，跑提取不触发文案。
2. **提取粒度 = 原图 × 类别**：勾选 N 张原图、M 个类别 → 最多 N×M 次上游调用，`progress.total = N×M`。
   单条失败不影响其他条，成功的照常入库，整体按 `partial` 记录。
3. **素材必须带类别与来源**：`category` 与 `source_asset_id` 都不可为空，界面按类别分组展示。
4. **文案版本固化两样东西**：生成出来的三段文案，以及当时选中的素材 id 列表；之后素材被删，
   版本里仍能看出当时选了什么（展示为「已删除素材」而不是丢数据）。
5. **`version_no` 在资源夹内递增且不复用**：删掉 v2 后再生成是 v4，不是 v2。
6. **发布记录挂文案版本**：一个文案版本最多一条发布记录；重复标记更新而不是新增。
7. **旧数据一次性迁移**（ADR 0010 第 6 条），迁移后旧表删除，代码只保留新模型一条路径。
8. **删除资源夹**级联删除提取运行、素材、文案版本与发布记录。

### SHOULD

- 提取运行与文案生成都在后台执行（进程内 worker），创建接口立即返回。
- 素材库里按类别分组，组内按生成时间倒序；每组显示数量。
- 文案版本列表显示版本号、生成时间、素材数量与标题首行，点开可看完整内容。

### MAY

- 素材支持手动删除（删除后引用它的版本显示「已删除素材」）。

### MUST NOT

- 不得让「生成文案」自动触发提取，也不得让「AI 处理」顺带生成文案。
- 不得覆盖历史版本：编辑当前版本文案时，产生的是同一版本内的编辑还是新版本，由界面明确告知
  （第一版：编辑当前版本 = 原地修改该版本；「重新生成」= 新版本）。
- 不得把素材挂到某个文案版本下（素材属于资源夹，可被多版引用）。
- 不得为迁移保留第二套查询路径。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/collections/[id]/extractions` | 发起提取：`{ sourceAssetIds, categories, requirement, extraPrompt? }` |
| GET | `/api/collections/[id]/extractions` | 提取运行列表（含进度与失败原因） |
| GET | `/api/collections/[id]/library` | 素材库，按类别分组返回 |
| DELETE | `/api/library/[assetId]` | 删除一张素材 |
| POST | `/api/collections/[id]/copy-versions` | 生成文案：`{ selectedAssetIds, copyStyle, extraPrompt? }` |
| GET | `/api/collections/[id]/copy-versions` | 版本列表（倒序） |
| PATCH | `/api/copy-versions/[id]` | 编辑当前版本的标题/正文/标签（原地） |
| POST | `/api/copy-versions/[id]/publish` | 标记已发布（幂等） |

## 页面结构

资源夹详情三个页签：

| 页签 | 内容 |
| --- | --- |
| 原始素材 | 原图网格（可勾选）+ 来源信息 + 提取目标 + 提取要求 + 「AI 处理」按钮 + 进行中提取的进度 |
| 素材库 | 提取产物，按类别分组（材质纹理 / 边框样式 / 其他），可多选、可删除、可点开预览 |
| 发布 | ① 从素材库分组选素材 ②「生成文案」③ 当前版本文案（可编辑、可复制）④ 历史版本列表 ⑤ 标记已发布 |

图片一律在站内弹窗预览（`docs/prd/07`「图片预览」）。

## 验收标准

| 编号 | 断言 |
| --- | --- |
| AC-LIB-1 | 勾选 2 张原图 + 2 个类别发起提取，`progress.total = 4`，成功后素材库出现 4 条素材（2 类各 2 条），每条都带来源原图 |
| AC-LIB-2 | 其中 1 条失败：其余 3 条正常入库，运行状态为 `partial`，失败项有可读原因 |
| AC-LIB-3 | 同一资源夹再跑一次提取，素材总数增加而不是覆盖；旧素材仍在 |
| AC-LIB-4 | 生成文案不触发任何提取调用；提取也不产生文案版本（用调用计数断言） |
| AC-LIB-5 | 选 3 张素材生成文案 → 产生 v1，`selected_asset_ids` 正好是这 3 张；再选另外 2 张生成 → v2，两版并存 |
| AC-LIB-6 | 删除一张被 v1 引用的素材后，v1 仍能打开，被删素材显示为「已删除素材」 |
| AC-LIB-7 | 删除 v2 后再生成，新版本号是 v3（不复用 v2） |
| AC-LIB-8 | 同一文案版本重复标记发布，发布记录仍为 1 条 |
| AC-LIB-9 | 旧数据迁移后：历史结果在文案版本列表里可见（v1），历史生成图在素材库「其他（历史）」分组里可见 |
| AC-LIB-10 | 资源夹详情三个页签与 PRD 第「页面结构」节一致；原始素材页签里没有素材与文案 |

## 验证方式

```bash
pnpm check && pnpm test:e2e
```

迁移演练（必须人工做一次并写进验收记录）：在真实库副本上跑迁移 → 核对行数、抽查 2 条历史结果的
素材与版本对应关系 → 再从界面打开看显示是否正确。
