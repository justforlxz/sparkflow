/**
 * 四角框选与单应透视矫正的**纯逻辑**（MKACG-1001、docs/prd/13-quad-rectify.md）：
 * 归一化四点的形状与校验、源四边形 → 目标矩形的单应矩阵、消失点法推算真实长宽比。
 *
 * 为什么必须由代码算：生成模型做不了度量几何。图生图实测 4 次只有 1 次文字全对，
 * 角色每次都被重画，提示词明写「不要摆正透视」也拦不住。几何一旦交给模型，
 * 长宽比与正视图就永远不可靠（issue「为什么必须这么做」）。所以：
 *
 * - 这里只有纯函数，不碰磁盘与数据库，单测在 `quad.test.ts`；
 * - 比例准确性用**合成图**验证（已知真实尺寸 + 已知相机投影），不靠肉眼（AC-QUAD-2）。
 *
 * 坐标系约定：`NormalizedQuad` 的四点是**摆正后**的图片坐标归一化到 0–1，
 * 顺序固定「左上 → 右上 → 右下 → 左下」，与目标矩形的四角一一对应。
 * 「摆正后」指 EXIF 方向已经套用（浏览器渲染的就是这个方向），
 * 与 `image-generation/compress.ts` 的 `readImageDimensions` 同一口径。
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 归一化四点：顺序为「左上、右上、右下、左下」。 */
export type NormalizedQuad = readonly [Point, Point, Point, Point];

/** 框选的两种用法（issue SHOULD）：桌面/桌垫四角，或者印在桌面上的图案四角。 */
export const QUAD_KINDS = ["surface", "pattern"] as const;

export type QuadKind = (typeof QUAD_KINDS)[number];

/** 界面文案（AGENTS.md 硬性规则 1：文案集中在模块常量里，不写死在组件里）。 */
export const QUAD_KIND_LABELS: Record<QuadKind, string> = {
  surface: "桌面 / 桌垫四个角",
  pattern: "图案本身的四个角",
};

export function isQuadKind(value: unknown): value is QuadKind {
  return typeof value === "string" && (QUAD_KINDS as readonly string[]).includes(value);
}

/**
 * 长宽比（宽 / 高）的可接受区间：超出说明估计已退化。
 * 按约定这时退回原图比例并在界面提示「比例未能估算」，**不阻断**（AC-QUAD-5）。
 */
export const MIN_ASPECT_RATIO = 0.2;
export const MAX_ASPECT_RATIO = 5;

/** 默认四角：图片内侧缩进 10%，用户拖动之前就是这个形状。 */
export const DEFAULT_QUAD_INSET = 0.1;

/** 面积下限：低于它视为退化（三点共线、两点重合），单应矩阵解不出来。 */
const MIN_QUAD_AREA = 1e-6;

/** 判定两条边「平行」的相对误差：此时消失点在无穷远处，标定方程退化。 */
const PARALLEL_EPSILON = 1e-9;

export function defaultQuad(): NormalizedQuad {
  const inset = DEFAULT_QUAD_INSET;
  const far = 1 - inset;
  return [
    { x: inset, y: inset },
    { x: far, y: inset },
    { x: far, y: far },
    { x: inset, y: far },
  ];
}

/** 归一化四点 `[[x,y]×4]`——数据库 `media_asset.quad` 的存储形状。 */
export type QuadPoints = readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
];

/** 把四点转成库里的存储形状。 */
export function toQuadPoints(quad: NormalizedQuad): QuadPoints {
  return quad.map((point) => [point.x, point.y]) as unknown as QuadPoints;
}

/**
 * 解析库里的 jsonb。形状不对、含非数字、坐标越界都返回 `null` ——
 * 坏数据不该让整个资源夹页面崩掉，调用方按「未校正」处理。
 */
export function parseQuad(value: unknown): NormalizedQuad | null {
  if (!Array.isArray(value) || value.length !== 4) return null;

  const points: Point[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [x, y] = entry as [unknown, unknown];
    if (typeof x !== "number" || typeof y !== "number") return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    points.push({ x, y });
  }

  return points as unknown as NormalizedQuad;
}

/** 有向面积的两倍（正负表示绕向，绝对值表示大小的两倍）。 */
function signedArea(quad: NormalizedQuad): number {
  let sum = 0;
  for (let index = 0; index < 4; index += 1) {
    const current = quad[index];
    const next = quad[(index + 1) % 4];
    sum += current.x * next.y - next.x * current.y;
  }
  return sum;
}

/** 三条连续边在顶点处转向的符号：凸多边形要求四个叉积同号。 */
function crossAt(previous: Point, current: Point, next: Point): number {
  return (
    (current.x - previous.x) * (next.y - current.y) -
    (current.y - previous.y) * (next.x - current.x)
  );
}

/**
 * 四点是否构成可保存的四边形（AC-QUAD-4）：
 *
 * - 坐标有限且落在 0–1 之间（归一化坐标，拖动只在图上）；
 * - 面积不为零（不是三点共线或两点重合）；
 * - 四个顶点的转向同号 —— 凹四边形与自交四边形（蝴蝶形）都会出现异号，一并挡掉。
 *
 * 与 `docs/prd/13` 的约定一致：只接受内角均 < 180° 的凸四边形。
 */
export function isValidQuad(quad: NormalizedQuad): boolean {
  for (const point of quad) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return false;
  }

  if (Math.abs(signedArea(quad)) < MIN_QUAD_AREA) return false;

  let positive = 0;
  let negative = 0;
  for (let index = 0; index < 4; index += 1) {
    const cross = crossAt(
      quad[index],
      quad[(index + 1) % 4],
      quad[(index + 2) % 4],
    );
    // 允许极小误差：用户拖动到像素级共线时不该被判成自交。
    if (cross > MIN_QUAD_AREA) positive += 1;
    else if (cross < -MIN_QUAD_AREA) negative += 1;
  }
  return positive === 4 || negative === 4;
}

/**
 * 「单位正方形 → 四边形」的经典闭式解（Heckbert）：把四点的映射写成齐次线性关系，
 * 平行四边形时透视项为 0，否则解出 `g`、`h` 两个透视项。
 * 返回值行主序 3×3（`h[8] = 1`），输入是单位正方形坐标 `(u,v) ∈ [0,1]²`，输出是四边形坐标。
 */
function unitSquareHomography(quad: NormalizedQuad): number[] | null {
  if (Math.abs(signedArea(quad)) < MIN_QUAD_AREA) return null;

  const [p0, p1, p2, p3] = quad;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;

  if (Math.abs(sx) < PARALLEL_EPSILON && Math.abs(sy) < PARALLEL_EPSILON) {
    // 平行四边形：透视项为 0，退化成仿射（正对拍摄或没有透视的四边形）。
    return [p1.x - p0.x, p2.x - p1.x, p0.x, p1.y - p0.y, p2.y - p1.y, p0.y, 0, 0, 1];
  }

  const determinant = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(determinant) < PARALLEL_EPSILON) return null;

  const g = (sx * dy2 - dx2 * sy) / determinant;
  const h = (dx1 * sy - sx * dy1) / determinant;
  return [
    p1.x - p0.x + g * p1.x,
    p3.x - p0.x + h * p3.x,
    p0.x,
    p1.y - p0.y + g * p1.y,
    p3.y - p0.y + h * p3.y,
    p0.y,
    g,
    h,
    1,
  ];
}

/**
 * 单位正方形 → **图片像素**的单应矩阵（行主序 3×3，`h[8] = 1`）。
 *
 * 这就是 `H = K [r1 r2 t] · diag(真实宽, 真实高, 1)` 的数值形式：`(u,v)` 是这块矩形在自己的
 * 平面坐标系里归一化后的位置，输出是它在照片里落到的像素点。长宽比推算正是对它做分解。
 *
 * 退化（面积为 0、图片尺寸非法）返回 `null`。
 */
export function unitSquareToImage(
  quad: NormalizedQuad,
  imageWidth: number,
  imageHeight: number,
): number[] | null {
  if (!isValidQuad(quad)) return null;
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight)) return null;
  if (imageWidth <= 0 || imageHeight <= 0) return null;

  const unit = unitSquareHomography(quad);
  if (!unit) return null;

  // 归一化坐标 → 像素：只放大输出的 x、y 两行。
  return [
    unit[0] * imageWidth,
    unit[1] * imageWidth,
    unit[2] * imageWidth,
    unit[3] * imageHeight,
    unit[4] * imageHeight,
    unit[5] * imageHeight,
    unit[6],
    unit[7],
    unit[8],
  ];
}

/**
 * **目标矩形像素 → 源图片像素**的单应矩阵：重采样按这个方向查表
 * （目标矩形的每个像素反查回原图上的一点，再双线性取样）。
 *
 * 它是 `unitSquareToImage` 先按目标尺寸归一化的结果 —— 目标矩形上的 `(X,Y)` 先除以
 * `(targetWidth, targetHeight)` 变成单位正方形坐标，再落到图片上。
 *
 * 退化时返回 `null`。
 */
export function rectToImage(
  quad: NormalizedQuad,
  image: { width: number; height: number },
  target: { width: number; height: number },
): number[] | null {
  if (target.width <= 0 || target.height <= 0) return null;
  if (!Number.isFinite(target.width) || !Number.isFinite(target.height)) return null;

  const unit = unitSquareToImage(quad, image.width, image.height);
  if (!unit) return null;

  // 前置缩放：列 1、列 2 分别除以目标宽高（源坐标换算成单位正方形坐标）。
  return [
    unit[0] / target.width,
    unit[1] / target.height,
    unit[2],
    unit[3] / target.width,
    unit[4] / target.height,
    unit[5],
    unit[6] / target.width,
    unit[7] / target.height,
    unit[8],
  ];
}

/**
 * 用消失点法推算真实长宽比（宽 / 高），估算失败返回 `null`（AC-QUAD-2、AC-QUAD-5）。
 *
 * 推导（假设针孔相机、方形像素、主点在画面中心）：
 *
 * 1. 单位正方形 → 图片的四点单应矩阵 `H = [h1 h2 h3]`；对平面矩形有 `H ~ K [r1 r2 t]`
 *    （`r1 ⟂ r2` 是两个方向的单位旋转向量，`K = diag(f, f, 1)`）。
 * 2. 正交约束 `(K⁻¹h1)·(K⁻¹h2) = 0` 给出唯一未知量焦距的平方：
 *    `f² = -[(a - cx·g)(b - cx·h) + (d - cy·g)(e - cy·h)] / (g·h)`。
 * 3. `|K⁻¹h1| / |K⁻¹h2|` 就是两个方向在真实平面上的长度比，即长宽比。
 *
 * 退化情形（两条对边平行 → 消失点在无穷远，`g` 或 `h` 为 0；解出的 `f²` 非正；
 * 比例超出 `[0.2, 5]`）一律返回 `null`：调用方退回原图比例并提示「比例未能估算」。
 *
 * 正对拍摄（四条边两两平行）时没有透视可解，退回「两条边长的像素比」——
 * 那是无透视假设下唯一合理的答案，也是合成图 AC-QUAD-2 的第一组用例。
 */
export function estimateAspectRatio(
  quad: NormalizedQuad,
  imageWidth: number,
  imageHeight: number,
): number | null {
  if (!isValidQuad(quad)) return null;
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight)) return null;
  if (imageWidth <= 0 || imageHeight <= 0) return null;

  // 单位正方形 → 图片像素：消去归一化带来的 x/y 不同尺度，才能用「方形像素」的假设。
  const matrix = unitSquareToImage(quad, imageWidth, imageHeight);
  if (!matrix) return null;

  const [a, b, , d, e, , g, h] = matrix;
  const cx = imageWidth / 2;
  const cy = imageHeight / 2;

  const noHorizontalPerspective = Math.abs(g) < PARALLEL_EPSILON;
  const noVerticalPerspective = Math.abs(h) < PARALLEL_EPSILON;

  if (noHorizontalPerspective && noVerticalPerspective) {
    // 四条边两两平行：没有消失点可解。退回无透视假设下的像素边长比。
    return clampAspectRatio(Math.hypot(a, d) / Math.hypot(b, e));
  }
  // 只有一对边平行：另一方向的消失点仍可求，但焦距无从解出，判为估算失败。
  if (noHorizontalPerspective || noVerticalPerspective) return null;

  const focalSquared = -((a - cx * g) * (b - cx * h) + (d - cy * g) * (e - cy * h)) / (g * h);
  if (!Number.isFinite(focalSquared) || focalSquared <= 0) return null;

  const firstDirection =
    ((a - cx * g) * (a - cx * g) + (d - cy * g) * (d - cy * g)) / focalSquared + g * g;
  const secondDirection =
    ((b - cx * h) * (b - cx * h) + (e - cy * h) * (e - cy * h)) / focalSquared + h * h;

  if (!Number.isFinite(firstDirection) || !Number.isFinite(secondDirection)) return null;
  if (firstDirection <= PARALLEL_EPSILON || secondDirection <= PARALLEL_EPSILON) return null;

  return clampAspectRatio(Math.sqrt(firstDirection / secondDirection));
}

/** 比例落在 `[0.2, 5]` 之外视为估算失败（issue「实现要点」2）。 */
function clampAspectRatio(ratio: number): number | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  if (ratio < MIN_ASPECT_RATIO || ratio > MAX_ASPECT_RATIO) return null;
  return ratio;
}

/** 长宽比的来源：手输 / 消失点估算 / 估算失败退回原图比例。界面按它决定是否提示。 */
export const ASPECT_SOURCES = ["manual", "estimated", "fallback"] as const;

export type AspectSource = (typeof ASPECT_SOURCES)[number];

export interface ResolvedAspect {
  /** 实际用于推导输出尺寸的比例（宽 / 高）。 */
  ratio: number;
  source: AspectSource;
}

/**
 * 决定用哪个长宽比（AC-QUAD-5、AC-QUAD-6）：**手输优先**，其次消失点估算，
 * 估算失败退回原图比例且不阻断（界面提示「比例未能估算」）。
 *
 * 三条取值互不覆盖：手输是用户给的确定值；估算是从几何推出来的；退回是「没有可靠答案时的
 * 已知最不坏值」。把这三件事分开记下来，界面才能如实说明这张图的比例是怎么来的。
 */
export function resolveAspectRatio(options: {
  quad: NormalizedQuad;
  imageWidth: number;
  imageHeight: number;
  realSize: { width: number; height: number } | null;
}): ResolvedAspect {
  const { quad, imageWidth, imageHeight, realSize } = options;

  if (realSize && realSize.width > 0 && realSize.height > 0) {
    return { ratio: realSize.width / realSize.height, source: "manual" };
  }

  const estimated = estimateAspectRatio(quad, imageWidth, imageHeight);
  if (estimated !== null) return { ratio: estimated, source: "estimated" };

  // 原图比例也可能是 0（读不到尺寸）：兜底给 1，宁可出正方形也不出非法尺寸。
  const fallback =
    Number.isFinite(imageWidth) && Number.isFinite(imageHeight) && imageWidth > 0 && imageHeight > 0
      ? imageWidth / imageHeight
      : 1;
  return { ratio: fallback, source: "fallback" };
}

/** 记在 `media_asset` 上的一次框选：四点 + 用途，以及可选的手输实际尺寸。 */
export interface StoredQuad {
  quad: NormalizedQuad;
  kind: QuadKind;
  /** 用户手输的实际尺寸（毫米）；有值时以它的比例为准，比估算更可靠（AC-QUAD-6）。 */
  realSize: { width: number; height: number } | null;
}
