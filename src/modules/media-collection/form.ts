/**
 * multipart 表单读取：把 `Request` 拆成「字段字典 + 文件列表」交给 schema 与上传校验。
 * 只接受 multipart（图片随表单一起提交），其它 content-type 直接按参数错误处理。
 */
import type { ZodType } from "zod";
import { AppError } from "@/lib/errors";
import type { IncomingFile } from "./uploads";

export interface MultipartFilePart extends IncomingFile {
  /** part 名，例如 `images-0`；整组保存用 `file:<tempKey>` 与 assets 清单对应。 */
  partName: string;
}

export interface MultipartPayload {
  fields: Record<string, unknown>;
  files: MultipartFilePart[];
}

export async function readMultipart(request: Request): Promise<MultipartPayload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw AppError.validationFailed("请求必须是 multipart/form-data 表单");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw AppError.validationFailed("表单内容无法解析");
  }

  const fields: Record<string, unknown> = {};
  const files: MultipartFilePart[] = [];

  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      fields[key] = value;
      continue;
    }

    files.push({
      partName: key,
      fileName: value.name || "未命名文件",
      bytes: Buffer.from(await value.arrayBuffer()),
    });
  }

  return { fields, files };
}

/**
 * 读 multipart 里的 JSON part（整组保存的 `fields` 与 `assets`）：
 * 不是字符串或不是合法 JSON 时按参数错误处理，内容本身交给 `schema` 校验。
 */
export function parseJsonPart<T>(raw: unknown, schema: ZodType<T>, label: string): T {
  if (typeof raw !== "string") throw AppError.validationFailed(`缺少 ${label} 部分`);

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw AppError.validationFailed(`${label} 必须是合法的 JSON`);
  }
  return schema.parse(value);
}
