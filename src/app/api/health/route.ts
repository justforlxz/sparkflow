import { getSchemaVersion } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { okResponse, route } from "@/lib/http";
import { logger } from "@/lib/logger";
import { APP_VERSION } from "@/lib/version";

// 健康检查每次都要读数据库，不能缓存。
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  let schemaVersion: number;
  try {
    schemaVersion = await getSchemaVersion();
  } catch (error) {
    logger.error("健康检查失败：数据库不可达", { error });
    throw new AppError("UPSTREAM_FAILED", "数据库不可达", { status: 503, cause: error });
  }

  return okResponse({ status: "ok", version: APP_VERSION, schemaVersion });
});
