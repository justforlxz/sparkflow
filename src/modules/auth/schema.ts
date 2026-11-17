import { z } from "zod";
import { PASSWORD_MIN_LENGTH } from "./password";

/**
 * 邮箱的唯一定义：去空格、转小写、格式校验（docs/prd/11-accounts.md 要求「存储前转小写」）。
 * 页面 action、接口 route、命令行脚本都只使用这里的定义，归一化不散落在调用点。
 */
export const emailSchema = z.string().trim().toLowerCase().email("邮箱格式不正确");

export const registerSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1, "姓名不能为空").max(60, "姓名过长"),
  password: z.string().min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 个字符`),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "密码不能为空"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
