/**
 * multipart 表单读取：把 `Request` 拆成「字段字典 + 文件列表」交给 schema 与上传校验。
 * 只接受 multipart（图片随表单一起提交），其它 content-type 直接按参数错误处理。
 */
import { AppError } from "@/lib/errors";
import type { IncomingFile } from "./uploads";

export interface MultipartPayload {
  fields: Record<string, unknown>;
  files: IncomingFile[];
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
  const files: IncomingFile[] = [];

  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      fields[key] = value;
      continue;
    }

    files.push({
      fileName: value.name || "未命名文件",
      bytes: Buffer.from(await value.arrayBuffer()),
    });
  }

  return { fields, files };
}
