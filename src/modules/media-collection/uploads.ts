/**
 * 上传文件的校验（MUST 3）：类型按文件内容判断，大小按 `MAX_UPLOAD_BYTES`，
 * 原始文件名只用于展示与报错文案，不参与落盘路径。
 */
import { detectImageMime } from "./image-type";
import { COLLECTION_ERROR_MESSAGES, formatBytes } from "./rules";
import { AppError } from "@/lib/errors";
import type { ImageMime } from "./constants";

export interface IncomingFile {
  /** 用户上传时的原始文件名，仅作展示字段。 */
  fileName: string;
  bytes: Buffer;
}

export interface PreparedImage extends IncomingFile {
  mimeType: ImageMime;
}

/** 逐张校验；任何一张不合格就整体拒绝，避免只存一半图片。 */
export function prepareImages(files: readonly IncomingFile[], maxBytes: number): PreparedImage[] {
  return files.map((file) => {
    if (file.bytes.length === 0) {
      throw AppError.validationFailed(COLLECTION_ERROR_MESSAGES.emptyFile(file.fileName));
    }

    if (file.bytes.length > maxBytes) {
      throw AppError.validationFailed(
        COLLECTION_ERROR_MESSAGES.tooLarge(file.fileName, formatBytes(maxBytes)),
        { maxUploadBytes: maxBytes },
      );
    }

    const mimeType = detectImageMime(file.bytes);
    if (!mimeType) {
      throw AppError.validationFailed(COLLECTION_ERROR_MESSAGES.unsupportedType(file.fileName));
    }

    return { ...file, mimeType };
  });
}
