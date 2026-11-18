/**
 * 最小 ZIP 打包（docs/prd/08 MUST 3「下载所选图片」、AC-09-10）。
 *
 * 只用 Node 内置能力拼 ZIP 结构：条目采用 stored（不压缩）——生成图片本身已是压缩格式，
 * 再压一遍几乎没有收益，却要引入第三方依赖。格式规范是 PKWARE APPNOTE：
 * 每个条目一段 local file header + 原始字节，最后是 central directory 与 end of central directory。
 *
 * 文件名由调用方给出（含序号），本文件只负责把它们按传入顺序写进压缩包。
 */
import { ZIP_NAME_MIN_DIGITS } from "./constants";

export interface ZipEntry {
  name: string;
  bytes: Buffer;
}

/** ZIP 的 32 位 CRC-32（多项式 0xEDB88320），stored 条目也必须带。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_RECORD_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_RECORD_SIZE = 22;
/** 版本 2.0：只需要 stored 能力。 */
const VERSION = 20;
/** 通用标志位第 11 位：文件名按 UTF-8 编码（中文标题也能被标准解压工具正确显示）。 */
const UTF8_NAME_FLAG = 0x0800;
const STORE_METHOD = 0;

/** DOS 时间格式：秒只有 2 秒精度；日期从 1980 起算。 */
function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * 打包成 ZIP。`modifiedAt` 显式给出，让单测能拿到确定字节。
 */
export function createZip(entries: readonly ZipEntry[], modifiedAt: Date): Buffer {
  const { time, date } = dosDateTime(modifiedAt);
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.bytes);
    const size = entry.bytes.byteLength;

    const header = Buffer.alloc(LOCAL_HEADER_SIZE);
    header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(UTF8_NAME_FLAG, 6);
    header.writeUInt16LE(STORE_METHOD, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(size, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.byteLength, 26);
    header.writeUInt16LE(0, 28);
    parts.push(header, name, entry.bytes);

    const record = Buffer.alloc(CENTRAL_HEADER_SIZE);
    record.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    record.writeUInt16LE(VERSION, 4);
    record.writeUInt16LE(VERSION, 6);
    record.writeUInt16LE(UTF8_NAME_FLAG, 8);
    record.writeUInt16LE(STORE_METHOD, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(size, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.byteLength, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += LOCAL_HEADER_SIZE + name.byteLength + size;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(END_RECORD_SIZE);
  end.writeUInt32LE(END_RECORD_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, directory, end]);
}

/**
 * ZIP 内的文件名：`01-原文件名`。序号按传入顺序从 1 开始，位数随总数增长，
 * 因此解包后按名称排序就是用户勾选的顺序（AC-09-10）。
 */
export function numberedZipName(index: number, total: number, fileName: string): string {
  const digits = Math.max(ZIP_NAME_MIN_DIGITS, String(total).length);
  const safeName = fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "image";
  return `${String(index + 1).padStart(digits, "0")}-${safeName}`;
}
