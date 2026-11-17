/**
 * 会话 cookie 名：`src/proxy.ts` 只判断 cookie 是否存在，`src/modules/auth/cookies.ts` 负责读写。
 * 名字必须一处定义，改一处漏一处会让会话静默失效。
 */
export const SESSION_COOKIE = "sparkflow_session";

/** proxy 把原请求路径写给下游页面，让 layout 的会话失效跳转也能带上 next。 */
export const PATHNAME_HEADER = "x-sparkflow-pathname";
