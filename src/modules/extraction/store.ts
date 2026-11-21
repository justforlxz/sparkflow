/**
 * 提取运行的持久化端口与文件端口。
 *
 * runner 只依赖这两个接口：真实实现在 `repo.ts` 与 `storage.ts`，单测用内存实现替代，
 * 这样「成功才入库」「部分失败记 partial」「重启恢复」这些语义可以脱离数据库断言。
 */
import type { ExtractionStatus } from "./constants";
import type {
  ExtractedImage,
  ExtractionErrorRecord,
  ExtractionProgress,
  ExtractionRunRecord,
  LibraryAssetInput,
} from "./types";

export interface ExtractionStore {
  /** 取下一个排队中的运行并原子地置为 running；没有可跑的就是 null。 */
  claimNextRun(now: Date): Promise<ExtractionRunRecord | null>;
  /** 只更新仍处于 running 的运行；返回受影响行数，0 表示这一行已不存在或已被改判。 */
  updateRunProgress(runId: string, progress: ExtractionProgress): Promise<number>;
  /** 写终态：`succeeded` / `partial` / `failed`，同时清空进度。 */
  finishRun(
    runId: string,
    status: ExtractionStatus,
    error: ExtractionErrorRecord | null,
    now: Date,
  ): Promise<number>;
  /** 启动时把残留的 running 记为失败；返回处理条数。 */
  failRunningRuns(error: ExtractionErrorRecord, now: Date): Promise<number>;
  /** 把这一批素材写进素材库；与终态不在同一个事务里（素材先入库，失败原因后写）。 */
  saveAssets(
    runId: string,
    collectionId: string,
    assets: readonly LibraryAssetInput[],
  ): Promise<void>;
}

export interface LibraryWriter {
  /** 把图片写进 `<UPLOAD_DIR>/library-assets/<runId>/`，返回落库需要的 storage_key。 */
  write(runId: string, images: readonly ExtractedImage[]): Promise<LibraryAssetInput[]>;
}
