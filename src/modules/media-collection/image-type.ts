/**
 * 图片类型判断（MUST 3）：只看文件内容开头的魔数，不看扩展名、不信任客户端给的 MIME。
 * 返回 `null` 表示不是受支持的图片，由调用方翻译成用户可读的拒绝原因。
 */
import type { ImageMime } from "./constants";

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWithBytes(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

export function detectImageMime(bytes: Uint8Array): ImageMime | null {
  if (startsWithBytes(bytes, JPEG_MAGIC)) return "image/jpeg";
  if (startsWithBytes(bytes, PNG_MAGIC)) return "image/png";
  // WebP：RIFF....WEBP，长度至少 12 字节。
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}
