/**
 * 环境变量唯一入口：只有「这台机器怎么跑」进环境变量，业务配置在数据库或模块常量里。
 * 首次使用时校验；校验失败直接抛错（启动时由 `src/instrumentation.ts` 触发，做到启动即失败）。
 */
import { z } from "zod";

/** 允许把空字符串当作「未设置」，便于 compose 与本地脚本传空值覆盖。 */
const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL 未设置"),
  UPLOAD_DIR: z.string().min(1).default("./data/uploads"),
  /** 会话令牌与将来密钥加密的派生源，必填且不得过短。 */
  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET 至少 32 个字符（可用 openssl rand -base64 48 生成）"),
  /** 是否信任反向代理注入的 `x-forwarded-for`（登录限速用）。直连部署保持 false。 */
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  /** 上传大小上限，业务层校验时使用。 */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  /** 外部模型适配器：`mock` 用于自动化验收，不消耗真实额度。 */
  GENERATION_ADAPTER: z.enum(["real", "mock"]).default("real"),
  /** 版本号覆盖；未设置时取 package.json 的 version。 */
  APP_VERSION: optionalString,
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `- ${issue.path.join(".") || "(根)"}: ${issue.message}`,
    );
    throw new Error(`环境变量校验失败：\n${lines.join("\n")}`);
  }
  return result.data;
}

let cachedEnv: Env | undefined;

export function getEnv(): Env {
  cachedEnv ??= parseEnv(process.env);
  return cachedEnv;
}
