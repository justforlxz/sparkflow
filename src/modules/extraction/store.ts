/**
 * 提取运行的持久化端口与文件端口。
 *
 * runner 只依赖这两个接口：真实实现在 `repo.ts` 与 `storage.ts`，单测用内存实现替代，
 * 这样「成功才入库」「部分失败记 partial」「全部判定为不存在记 empty」「重启恢复」这些语义
 * 可以脱离数据库断言。
 */
import type { ExtractionStatus } from "./constants";
import type {
  ExtractedImage,
  ExtractionErrorRecord,
  ExtractionItemInput,
  ExtractionProgress,
  ExtractionRunRecord,
  LibraryAssetInput,
  LibraryAssetRecord,
} from "./types";

export interface ExtractionStore {
  /** 取下一个排队中的运行并原子地置为 running；没有可跑的就是 null。 */
  claimNextRun(now: Date): Promise<ExtractionRunRecord | null>;
  /**
   * 只更新仍处于 running 的运行；返回受影响行数，0 表示这一行已不存在或已被改判。
   * `currentItemKey` 与进度同一笔写入：界面靠它区分「处理中」与「等待中」（MKACG-999）。
   */
  updateRunProgress(
    runId: string,
    progress: ExtractionProgress,
    currentItemKey: string | null,
  ): Promise<number>;
  /** 写终态：`succeeded` / `partial` / `failed` / `empty`，同时清空进度。 */
  finishRun(
    runId: string,
    status: ExtractionStatus,
    error: ExtractionErrorRecord | null,
    now: Date,
  ): Promise<number>;
  /** 启动时把残留的 running 记为失败；返回处理条数。 */
  failRunningRuns(error: ExtractionErrorRecord, now: Date): Promise<number>;
  /**
   * 把这一批素材写进素材库；与终态不在同一个事务里（素材先入库，失败原因后写）。
   * 返回落库后的记录：条目要用它拿到 `library_asset_id`（ADR 0011 第 3 条）。
   */
  saveAssets(
    runId: string,
    collectionId: string,
    assets: readonly LibraryAssetInput[],
  ): Promise<LibraryAssetRecord[]>;
  /** 写这一批提取条目（succeeded / skipped / failed 三种结局各一条）。 */
  saveItems(runId: string, items: readonly ExtractionItemInput[]): Promise<void>;
}

export interface LibraryWriter {
  /** 把图片写进 `<UPLOAD_DIR>/library-assets/<runId>/`，返回落库需要的 storage_key。 */
  write(runId: string, images: readonly ExtractedImage[]): Promise<LibraryAssetInput[]>;
}
