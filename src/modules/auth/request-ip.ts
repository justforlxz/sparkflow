/**
 * 取限速键。
 *
 * `x-forwarded-for` 由调用方完全可控（Next.js 只在该头缺失时才用连接层地址补写），
 * 直接采信会让限速被一个伪造头绕过。因此：
 * - 配置了可信反向代理（`TRUST_PROXY=true`）时，取该头第一段；
 * - 否则不采信任何请求头，全站共用一个键 —— 无法伪造，代价是攻击者可能占满额度。
 */
export function clientIp(headers: Headers, trustProxy: boolean): string {
  if (!trustProxy) return "direct";

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "direct";
}
