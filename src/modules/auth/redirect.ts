/** 登录成功后的跳转目标：只接受站内相对路径，避免开放重定向（AC-11-5）。 */
const INTERNAL_ORIGIN = "http://internal.invalid";

export function safeNextPath(value: string | null | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";

  try {
    const url = new URL(value, INTERNAL_ORIGIN);
    if (url.origin !== INTERNAL_ORIGIN) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
