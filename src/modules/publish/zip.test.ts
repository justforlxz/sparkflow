import { describe, expect, test } from "vitest";
import { createZip, numberedZipName } from "./zip";

/**
 * ZIP 打包（docs/prd/08 MUST 3、AC-09-10）：文件名按选中顺序编号，压缩包能被标准工具解开。
 * 这里直接按 PKWARE 的目录结构解析生成结果，避免只断言「看起来像 ZIP」。
 */

interface ParsedEntry {
  name: string;
  crc: number;
  bytes: Buffer;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;

/** 按 central directory 逐个条目还原文件内容，结构与标准解压工具读的是同一份目录。 */
function readZip(archive: Buffer): ParsedEntry[] {
  const endOffset = archive.lastIndexOf(
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  );
  expect(endOffset).toBeGreaterThanOrEqual(0);
  expect(archive.readUInt32LE(endOffset)).toBe(END_SIGNATURE);

  const count = archive.readUInt16LE(endOffset + 10);
  let cursor = archive.readUInt32LE(endOffset + 16);
  const entries: ParsedEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(CENTRAL_SIGNATURE);
    const crc = archive.readUInt32LE(cursor + 16);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    expect(archive.readUInt32LE(localOffset)).toBe(LOCAL_SIGNATURE);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const bodyStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({ name, crc, bytes: archive.subarray(bodyStart, bodyStart + size) });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

describe("打包下载", () => {
  const modifiedAt = new Date(2026, 10, 18, 9, 30, 0);

  test("条目顺序与传入顺序一致，文件名与内容都能还原", () => {
    const first = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const second = Buffer.from("第二张图片的内容", "utf8");

    const archive = createZip(
      [
        { name: "01-第一张.png", bytes: first },
        { name: "02-第二张.png", bytes: second },
      ],
      modifiedAt,
    );

    const entries = readZip(archive);
    expect(entries.map((entry) => entry.name)).toEqual(["01-第一张.png", "02-第二张.png"]);
    expect(entries[0]?.bytes.equals(first)).toBe(true);
    expect(entries[1]?.bytes.equals(second)).toBe(true);
  });

  test("CRC-32 与标准值一致（`123456789` 的 CRC 是 0xCBF43926）", () => {
    const archive = createZip(
      [{ name: "check.txt", bytes: Buffer.from("123456789", "ascii") }],
      modifiedAt,
    );

    expect(readZip(archive)[0]?.crc).toBe(0xcbf43926);
  });

  test("ZIP 内文件名按勾选顺序编号，两位起、数量多了自然加宽（AC-09-10）", () => {
    expect(numberedZipName(0, 3, "a.png")).toBe("01-a.png");
    expect(numberedZipName(2, 3, "c.png")).toBe("03-c.png");
    expect(numberedZipName(11, 12, "l.png")).toBe("12-l.png");
  });

  test("文件名里的路径分隔符被替换，避免解包时写到别处", () => {
    expect(numberedZipName(0, 1, "../evil/name.png")).toBe("01-.._evil_name.png");
    expect(numberedZipName(0, 1, "   ")).toBe("01-image");
  });
});
