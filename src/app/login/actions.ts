"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getEnv } from "@/lib/env";
import { clientIp } from "@/modules/auth/request-ip";
import { safeNextPath } from "@/modules/auth/redirect";
import { loginSchema, registerSchema } from "@/modules/auth/schema";
import { login, persistSession, registerFirstUser } from "@/modules/auth/service";

type ErrorKind = "login" | "register" | "password" | "closed" | "rate";

async function requestMeta(): Promise<{ ip: string; userAgent: string | null }> {
  const headerStore = await headers();
  return {
    ip: clientIp(headerStore, getEnv().TRUST_PROXY === "true"),
    userAgent: headerStore.get("user-agent"),
  };
}

function redirectWithError(kind: ErrorKind, nextPath: string): never {
  const params = new URLSearchParams({ error: kind });
  if (nextPath !== "/") params.set("next", nextPath);
  redirect(`/login?${params.toString()}`);
}

export async function loginAction(formData: FormData): Promise<void> {
  const nextPath = safeNextPath(String(formData.get("next") ?? ""));

  // 与 /api/auth/login 共用同一份 schema：校验与邮箱归一化只有一处。
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) redirectWithError("login", nextPath);

  const meta = await requestMeta();
  let grant;
  try {
    grant = await login({ ...parsed.data, ip: meta.ip }, meta);
  } catch (error) {
    const status = (error as { status?: number }).status;
    redirectWithError(status === 429 ? "rate" : "login", nextPath);
  }

  await persistSession(grant);
  redirect(nextPath);
}

export async function registerAction(formData: FormData): Promise<void> {
  const nextPath = safeNextPath(String(formData.get("next") ?? ""));

  const parsed = registerSchema.safeParse({
    email: formData.get("email"),
    name: formData.get("name"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    const weakPassword = parsed.error.issues.some((issue) => issue.path[0] === "password");
    redirectWithError(weakPassword ? "password" : "register", nextPath);
  }

  let grant;
  try {
    grant = await registerFirstUser(parsed.data, await requestMeta());
  } catch (error) {
    const details = (error as { details?: { code?: string } }).details;
    const status = (error as { status?: number }).status;

    if (details?.code === "WEAK_PASSWORD") redirectWithError("password", nextPath);
    if (status === 403) redirectWithError("closed", nextPath);
    redirectWithError("register", nextPath);
  }

  await persistSession(grant);
  redirect(nextPath);
}
