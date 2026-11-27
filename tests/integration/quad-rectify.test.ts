import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import sharp from "sharp";
import { getDb } from "@/lib/db";
import { storageRoot } from "@/lib/storage";
import {
  defaultQuad,
  QUAD_KIND_LABELS,
  resolveAspectRatio,
  toQuadPoints,
  unitSquareToImage,
  type NormalizedQuad,
} from "@/modules/media-collection/quad";
import * as repo from "@/modules/media-collection/repo";
import {
  clearAssetQuad,
  deletePoolAsset,
  getRectifiedImage,
  saveAssetQuad,
  uploadPoolAssets,
} from "@/modules/media-collection/service";
import { RECTIFIED_MIME_TYPE } from "@/modules/media-collection/rectify";
import { deriveExtractionSizeFromRatio } from "@/modules/image-generation/vision-judgment";

/**
 * 四角框选 + 单应透视矫正的集成验收（MKACG-1001 AC-QUAD-1、AC-QUAD-2、AC-QUAD-4 ~ AC-QUAD-6）。
 *
 * 这里连真实 PostgreSQL 与真实磁盘：`media_asset` 的四个新列、矫正图的落盘与读取、
 * 清除框选时文件一并消失，这些都用内存替身测不出来。
 *
 * 比例准确性用**合成图**验（issue「验证方式」）：先把一张已知 2:1 的矩形图案按已知相机投影
 * 拍成「斜拍照片」，再让矫正复原它，比较复原结果与原图案的逐像素差异 —— 不靠肉眼。
 */

const createdAssetIds: string[] = [];

afterEach(async () => {
  for (const id of createdAssetIds.splice(0)) {
    await deletePoolAsset(id).catch(() => {});
  }
});

/** 图案尺寸（世界平面）：已知 2:1，用来验证比例复原误差 ≤ 10%（AC-QUAD-2）。 */
const MAT_WIDTH = 800;
const MAT_HEIGHT = 400;

/** 「斜拍照片」的画布尺寸。 */
const PHOTO_WIDTH = 900;
const PHOTO_HEIGHT = 700;

/**
 * 把世界平面上的矩形按一台针孔相机投影成归一化四点。
 * 与 `quad.test.ts` 里的合成图同一个相机模型（俯仰 + 偏摆，两个消失点都在有限远处）。
 */
function projectRectangle(options: {
  pitch: number;
  yaw: number;
  focal: number;
  distance: number;
}): NormalizedQuad {
  const { pitch, yaw, focal, distance } = options;
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cx = PHOTO_WIDTH / 2;
  const cy = PHOTO_HEIGHT / 2;

  const rotation = [
    [cosY, sinY * sinP, sinY * cosP],
    [0, cosP, -sinP],
    [-sinY, cosY * sinP, cosY * cosP],
  ];

  const project = (x: number, y: number): [number, number] => {
    const cameraX = rotation[0][0] * x + rotation[0][1] * y;
    const cameraY = rotation[1][0] * x + rotation[1][1] * y;
    const cameraZ = rotation[2][0] * x + rotation[2][1] * y + distance;
    return [(focal * cameraX) / cameraZ + cx, (focal * cameraY) / cameraZ + cy];
  };

  const corners: Array<[number, number]> = [
    project(-MAT_WIDTH / 2, -MAT_HEIGHT / 2),
    project(MAT_WIDTH / 2, -MAT_HEIGHT / 2),
    project(MAT_WIDTH / 2, MAT_HEIGHT / 2),
    project(-MAT_WIDTH / 2, MAT_HEIGHT / 2),
  ];

  return corners.map(([x, y]) => ({
    x: x / PHOTO_WIDTH,
    y: y / PHOTO_HEIGHT,
  })) as unknown as NormalizedQuad;
}

/** 一张 2:1 的「桌垫」图案：带文字与边框，便于断言内容被原样搬回来。 */
async function flatMat(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${MAT_WIDTH}" height="${MAT_HEIGHT}">
  <rect width="100%" height="100%" fill="#2f4f6f"/>
  <rect x="16" y="16" width="${MAT_WIDTH - 32}" height="${MAT_HEIGHT - 32}" fill="none" stroke="#f2e9d8" stroke-width="10"/>
  <text x="50%" y="44%" font-family="sans-serif" font-size="96" fill="#f2e9d8" text-anchor="middle">拾光 SPARKFLOW</text>
  <rect x="60" y="290" width="680" height="40" fill="#e0b040"/>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * 把平面图案「拍」进已知的四边形：对图案的每个像素按单应矩阵正向投影到照片上。
 *
 * 每像素取 3×3 子采样填空，避免正向映射留下针孔般的空洞。
 */
async function projectedPhoto(flat: Buffer, quad: NormalizedQuad): Promise<Buffer> {
  const { data: source, info } = await sharp(flat)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const matrix = unitSquareToImage(quad, PHOTO_WIDTH, PHOTO_HEIGHT);
  if (!matrix) throw new Error("合成图用的四边形解不出单应矩阵");
  const [a, b, c, d, e, f, g, h, i] = matrix;

  const canvas = Buffer.alloc(PHOTO_WIDTH * PHOTO_HEIGHT * 3, 255);
  const SUB = 3;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const u = (x + 0.5) / info.width;
      const v = (y + 0.5) / info.height;
      const offset = (y * info.width + x) * info.channels;

      for (let sy = 0; sy < SUB; sy += 1) {
        for (let sx = 0; sx < SUB; sx += 1) {
          const su = u + (sx + 0.5) / SUB / info.width - 0.5 / info.width;
          const sv = v + (sy + 0.5) / SUB / info.height - 0.5 / info.height;
          const denominator = g * su + h * sv + i;
          if (Math.abs(denominator) < Number.EPSILON) continue;
          const px = Math.round((a * su + b * sv + c) / denominator);
          const py = Math.round((d * su + e * sv + f) / denominator);
          if (px < 0 || py < 0 || px >= PHOTO_WIDTH || py >= PHOTO_HEIGHT) continue;
          const target = (py * PHOTO_WIDTH + px) * 3;
          canvas[target] = source[offset];
          canvas[target + 1] = source[offset + 1];
          canvas[target + 2] = source[offset + 2];
        }
      }
    }
  }

  return sharp(canvas, { raw: { width: PHOTO_WIDTH, height: PHOTO_HEIGHT, channels: 3 } })
    .png()
    .toBuffer();
}

async function poolAsset(bytes: Buffer) {
  const [asset] = await uploadPoolAssets([{ fileName: `${randomUUID()}.png`, bytes }]);
  if (!asset) throw new Error("上传合成照片失败");
  createdAssetIds.push(asset.id);
  return asset;
}

/** 读一张图的逐像素 RGB，供差异比较。 */
async function rawRgb(bytes: Buffer) {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * 两张同尺寸图片在内侧区域的逐像素平均绝对差（0–255）。
 * 只比内侧：四边形边缘与边界像素会被重采样与背景混色影响，那不是「内容被改写」。
 */
async function meanDifference(left: Buffer, right: Buffer): Promise<number> {
  const a = await rawRgb(left);
  const b = await rawRgb(right);
  expect(a.width).toBe(b.width);
  expect(a.height).toBe(b.height);

  const marginX = Math.floor(a.width * 0.06);
  const marginY = Math.floor(a.height * 0.06);
  let total = 0;
  let count = 0;
  for (let y = marginY; y < a.height - marginY; y += 1) {
    for (let x = marginX; x < a.width - marginX; x += 1) {
      const offset = (y * a.width + x) * a.channels;
      for (let channel = 0; channel < 3; channel += 1) {
        total += Math.abs(a.data[offset + channel] - b.data[offset + channel]);
        count += 1;
      }
    }
  }
  return total / Math.max(1, count);
}

test("AC-QUAD-1 保存四角：quad 存下 4 个归一化点、rectified_key 有值、磁盘读得到矫正图", async () => {
  const flat = await flatMat();
  const asset = await poolAsset(flat);

  const result = await saveAssetQuad(asset.id, {
    kind: "pattern",
    points: toQuadPoints(defaultQuad()),
    realSize: null,
  });

  const row = await repo.findAsset(asset.id);
  expect(row?.quad).toEqual(defaultQuad().map((point) => [point.x, point.y]));
  expect(row?.quadKind).toBe("pattern");
  expect(row?.rectifiedKey).toBeTruthy();
  expect(result.rectifiedUrl).toBe(`/api/files/assets/${asset.id}/rectified`);

  // 磁盘上真的有这份文件，而且鉴权读取接口能拿到 PNG 字节。
  const onDisk = await stat(`${storageRoot()}/${row?.rectifiedKey}`);
  expect(onDisk.size).toBeGreaterThan(0);
  const image = await getRectifiedImage(asset.id);
  expect(image.mimeType).toBe(RECTIFIED_MIME_TYPE);
  expect(image.bytes.byteLength).toBe(onDisk.size);

  const metadata = await sharp(image.bytes).metadata();
  expect(metadata.format).toBe("png");
  expect(metadata.width).toBe(result.rectifiedWidth);
  expect(metadata.height).toBe(result.rectifiedHeight);
});

test("AC-QUAD-2 合成图：800×400 按透视投影拍下后，矫正复原的比例误差 ≤ 10%", async () => {
  const flat = await flatMat();
  const quad = projectRectangle({
    pitch: (25 * Math.PI) / 180,
    yaw: (18 * Math.PI) / 180,
    focal: 1000,
    distance: 1000,
  });
  const photo = await projectedPhoto(flat, quad);
  const asset = await poolAsset(photo);

  const result = await saveAssetQuad(asset.id, {
    kind: "pattern",
    points: toQuadPoints(quad),
    realSize: null,
  });

  // 比例来自消失点法，不是原照片的 900:700。
  expect(result.aspectSource).toBe("estimated");
  expect(result.aspectRatio).toBeGreaterThan(2 * 0.9);
  expect(result.aspectRatio).toBeLessThan(2 * 1.1);

  const rectified = await getRectifiedImage(asset.id);
  const metadata = await sharp(rectified.bytes).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  expect(width / height).toBeGreaterThan(2 * 0.9);
  expect(width / height).toBeLessThan(2 * 1.1);
  // 「矫正图的长宽与原矩形同向」：宽仍然大于高。
  expect(width).toBeGreaterThan(height);
});

test("AC-QUAD-2 + AC-QUAD-9 矫正复原内容：与原图案逐像素平均差 < 20/255", async () => {
  const flat = await flatMat();
  const quad = projectRectangle({
    pitch: (20 * Math.PI) / 180,
    yaw: (14 * Math.PI) / 180,
    focal: 1100,
    distance: 1100,
  });
  const photo = await projectedPhoto(flat, quad);
  const asset = await poolAsset(photo);

  const result = await saveAssetQuad(asset.id, {
    kind: "pattern",
    points: toQuadPoints(quad),
    realSize: null,
  });

  const rectified = await getRectifiedImage(asset.id);
  // 同一张图案缩放到矫正图的尺寸作为基准：差异只来自两次重采样，不来自内容被改写。
  const expected = await sharp(flat)
    .resize({
      width: result.rectifiedWidth ?? undefined,
      height: result.rectifiedHeight ?? undefined,
      fit: "fill",
    })
    .png()
    .toBuffer();

  const difference = await meanDifference(rectified.bytes, expected);
  expect(difference, `逐像素平均差 ${difference.toFixed(2)}`).toBeLessThan(20);
});

test("AC-QUAD-10 同一张原图重复保存两次，矫正图字节完全一致", async () => {
  const flat = await flatMat();
  const asset = await poolAsset(flat);
  const points = toQuadPoints(defaultQuad());

  await saveAssetQuad(asset.id, { kind: "pattern", points, realSize: null });
  const first = await getRectifiedImage(asset.id);
  await saveAssetQuad(asset.id, { kind: "pattern", points, realSize: null });
  const second = await getRectifiedImage(asset.id);

  expect(first.bytes.equals(second.bytes)).toBe(true);
});

test("AC-QUAD-4 凹四边形与自交四边形被拒，库里不留半截状态", async () => {
  const asset = await poolAsset(await flatMat());

  const concave = toQuadPoints([
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.4, y: 0.4 },
    { x: 0.1, y: 0.9 },
  ] as unknown as NormalizedQuad);
  await expect(
    saveAssetQuad(asset.id, { kind: "surface", points: concave, realSize: null }),
  ).rejects.toThrow(/凸四边形/);

  const bowtie = toQuadPoints([
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.9 },
    { x: 0.9, y: 0.1 },
    { x: 0.1, y: 0.9 },
  ] as unknown as NormalizedQuad);
  await expect(
    saveAssetQuad(asset.id, { kind: "surface", points: bowtie, realSize: null }),
  ).rejects.toThrow(/凸四边形/);

  const row = await repo.findAsset(asset.id);
  expect(row?.quad).toBeNull();
  expect(row?.quadKind).toBeNull();
  expect(row?.rectifiedKey).toBeNull();
});

test("AC-QUAD-5 比例估算失败：退回原图比例、仍然产出矫正图（不阻断）", async () => {
  const asset = await poolAsset(await flatMat());

  // 只俯仰不偏摆的投影：一组对边保持平行，焦距无从解出 → 估算失败。
  const quad = projectRectangle({
    pitch: (30 * Math.PI) / 180,
    yaw: 0,
    focal: 1000,
    distance: 1000,
  });
  const result = await saveAssetQuad(asset.id, {
    kind: "surface",
    points: toQuadPoints(quad),
    realSize: null,
  });

  expect(result.aspectSource).toBe("fallback");
  expect(result.estimatedAspectRatio).toBeNull();
  // 退回的是这张原图自己的比例（800×400 的图案当原图上传）。
  expect(result.aspectRatio).toBeCloseTo(MAT_WIDTH / MAT_HEIGHT, 6);
  // 不阻断：矫正图照样生成，界面据此显示「比例未能估算」但仍然可以提取。
  expect(result.rectifiedUrl).not.toBeNull();
  expect(result.rectifiedError).toBeNull();
});

test("AC-QUAD-6 手输实际尺寸覆盖估算值", async () => {
  const flat = await flatMat();
  const quad = projectRectangle({
    pitch: (25 * Math.PI) / 180,
    yaw: (18 * Math.PI) / 180,
    focal: 1000,
    distance: 1000,
  });
  const asset = await poolAsset(await projectedPhoto(flat, quad));

  const result = await saveAssetQuad(asset.id, {
    kind: "pattern",
    points: toQuadPoints(quad),
    realSize: { width: 900, height: 300 },
  });

  expect(result.aspectSource).toBe("manual");
  expect(result.aspectRatio).toBeCloseTo(3, 6);
  // 估算值只用于对照，不参与输出尺寸。
  expect(result.estimatedAspectRatio).not.toBeNull();

  const expectedSize = deriveExtractionSizeFromRatio(3);
  expect(result.rectifiedWidth).toBe(expectedSize.width);
  expect(result.rectifiedHeight).toBe(expectedSize.height);

  const row = await repo.findAsset(asset.id);
  expect(row?.quadRealWidth).toBe(900);
  expect(row?.quadRealHeight).toBe(300);
});

test("清除框选：四个新列一起清空，矫正图从磁盘删掉", async () => {
  const asset = await poolAsset(await flatMat());
  await saveAssetQuad(asset.id, {
    kind: "surface",
    points: toQuadPoints(defaultQuad()),
    realSize: null,
  });
  const saved = await repo.findAsset(asset.id);
  const rectifiedKey = saved?.rectifiedKey;
  expect(rectifiedKey).toBeTruthy();
  await expect(stat(`${storageRoot()}/${rectifiedKey}`)).resolves.toBeTruthy();

  await clearAssetQuad(asset.id);

  const cleared = await repo.findAsset(asset.id);
  expect(cleared?.quad).toBeNull();
  expect(cleared?.quadKind).toBeNull();
  expect(cleared?.quadRealWidth).toBeNull();
  expect(cleared?.quadRealHeight).toBeNull();
  expect(cleared?.rectifiedKey).toBeNull();
  await expect(stat(`${storageRoot()}/${rectifiedKey}`)).rejects.toThrow();
});

test("AC-QUAD-7 未框选的原图：四个新列都是 NULL，与原行为一致", async () => {
  const asset = await poolAsset(await flatMat());

  const row = await repo.findAsset(asset.id);
  expect(row?.quad).toBeNull();
  expect(row?.quadKind).toBeNull();
  expect(row?.rectifiedKey).toBeNull();

  // 没有矫正图时读取接口给 404，界面按 `rectifiedUrl === null` 不显示。
  await expect(getRectifiedImage(asset.id)).rejects.toThrow(/还没有做四角矫正/);
});

test("从总资源库删照片时，矫正图一并清掉", async () => {
  const asset = await poolAsset(await flatMat());
  await saveAssetQuad(asset.id, {
    kind: "pattern",
    points: toQuadPoints(defaultQuad()),
    realSize: null,
  });
  const row = await repo.findAsset(asset.id);
  const rectifiedKey = row?.rectifiedKey;
  expect(rectifiedKey).toBeTruthy();

  await deletePoolAsset(asset.id);
  createdAssetIds.length = 0;

  await expect(stat(`${storageRoot()}/${rectifiedKey}`)).rejects.toThrow();
  expect(await getDb().mediaAsset.findUnique({ where: { id: asset.id } })).toBeNull();
});

test("两种框选用途的文案都登记在模块常量里，界面直接用", () => {
  // 断言这两个 key 存在：界面文案集中在这里（AGENTS.md 硬性规则 1）。
  expect(QUAD_KIND_LABELS.surface).toContain("桌面");
  expect(QUAD_KIND_LABELS.pattern).toContain("图案");
  // 比例解析在没有手输、没有估算时退回原图比例。
  expect(resolveAspectRatio({
    quad: defaultQuad(),
    imageWidth: 900,
    imageHeight: 700,
    realSize: null,
  }).source).toBe("estimated");
});
