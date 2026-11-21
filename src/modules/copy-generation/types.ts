/**
 * 文案版本的数据形状与文案处理器契约
 * （docs/prd/12-asset-library.md、docs/prd/06-copy-generation.md、ADR 0010）。
 *
 * 处理器只做「拿选中的素材 → 调文本模型 → 交出三段文案」；
 * 版本号、状态流转与写库都在 `service.ts` 与 `repo.ts`。
 */
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import type { FailureRecord } from "@/lib/job-failure";
import type { CopyVersionStatus } from "./constants";

/** 文案三段（解析与清洗规则见 `parse.ts`）。 */
export interface CopyContent {
  title: string;
  body: string;
  tags: string[];
}

/** 本次选中的一张素材：类别决定提示词里怎么描述它。 */
export interface SelectedAssetRef {
  id: string;
  category: string;
  fileName: string;
  mimeType: string;
}

/** 读出来的一张素材字节。 */
export interface AssetImageBytes {
  bytes: Buffer;
  mimeType: string;
}

/** 资源夹里文案要用的来源信息（不含原图：文案只围绕选中的素材写）。 */
export interface CopyCollectionContext {
  id: string;
  platform: string | null;
  sourceTitle: string | null;
  sourceBody: string | null;
}

/** 纹理已固化的版本快照：`title` / `body` / `tags` 成功前为空（docs/prd/06 解析规则）。 */
export interface CopyVersionRecord {
  id: string;
  collectionId: string;
  versionNo: number;
  status: CopyVersionStatus;
  title: string | null;
  body: string | null;
  tags: string[];
  copyStyle: string;
  agentSnapshot: AgentSnapshot;
  selectedAssetIds: string[];
  extraPrompt: string | null;
  error: FailureRecord | null;
  /** 调用摘要（模型、耗时、视觉提取的结局）。 */
  meta: Record<string, unknown> | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** 文案生成执行上下文：与这次版本相关的输入全都显式给出。 */
export interface CopyContext {
  versionId: string;
  collectionId: string;
  copyStyle: string;
  extraPrompt: string | null;
  agent: AgentSnapshot;
  collection: CopyCollectionContext;
  /** 本次选中的素材，顺序即版本的 `selected_asset_ids` 顺序。 */
  assets: readonly SelectedAssetRef[];
  signal: AbortSignal;
  /** 按 id 读一张素材的字节（视觉提取用；不直接查提取模块的表）。 */
  readAssetImage(assetId: string): Promise<AssetImageBytes>;
}

export interface CopyOutcome {
  copy: CopyContent;
  meta: Record<string, unknown>;
}

export interface CopyHandler {
  run(context: CopyContext): Promise<CopyOutcome>;
}
