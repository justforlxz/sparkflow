/**
 * 页面 `searchParams` 的扁平化：同名参数只取第一个字符串值。
 *
 * 资源夹列表与总资源库列表都把手改 URL 的参数交给 zod 校验，多处对「数组取第一项、
 * 非字符串丢弃」的处理必须一致，所以只留这一份实现。
 */
export function firstValues(
  params: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") result[key] = first;
  }
  return result;
}