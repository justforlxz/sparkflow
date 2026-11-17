import { AppError } from "@/lib/errors";
import { route } from "@/lib/http";

/**
 * 兜底：未定义的 /api 路径也返回统一错误信封，而不是 Next 默认的 HTML 404。
 */
const notFound = route(() => {
  throw AppError.notFound("接口不存在");
});

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
