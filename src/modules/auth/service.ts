/**
 * 账号与会话服务（docs/prd/11-accounts.md）。
 * 页面与接口都只调用这里的函数；邮箱归一化与格式校验由 `schema.ts` 完成，这里只接受已解析的输入。
 */
import { AppError } from "@/lib/errors";
import { clearSessionCookie, readSessionToken, writeSessionCookie } from "./cookies";
import { assertPasswordPolicy, hashPassword, verifyPassword } from "./password";
import { loginRateLimiter } from "./rate-limit";
import {
  countUsers,
  createFirstUser,
  createSession,
  findSessionByTokenHash,
  findUserByEmail,
  revokeAllSessions,
  revokeSession,
  touchLastLogin,
  updatePasswordHash,
} from "./repo";
import { emailSchema, type LoginInput, type RegisterInput } from "./schema";
import { isSessionUsable } from "./session-rules";
import { createSessionToken, hashSessionToken } from "./token";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface SessionGrant {
  user: AuthUser;
  token: string;
  expiresAt: Date;
}

interface RequestMeta {
  userAgent: string | null;
}

function toAuthUser(user: { id: string; email: string; name: string }): AuthUser {
  return { id: user.id, email: user.email, name: user.name };
}

async function issueSession(
  userId: string,
  userAgent: string | null,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = createSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await createSession({ tokenHash: hashSessionToken(token), userId, expiresAt, userAgent });
  return { token, expiresAt };
}

export async function hasAnyUser(): Promise<boolean> {
  return (await countUsers()) > 0;
}

/** 首个账号自助注册；已有账号时拒绝（AC-11-2）。成功后直接签发会话。 */
export async function registerFirstUser(
  input: RegisterInput,
  meta: RequestMeta,
): Promise<SessionGrant> {
  assertPasswordPolicy(input.email, input.password);

  const user = await createFirstUser({
    email: input.email,
    name: input.name,
    passwordHash: await hashPassword(input.password),
  });

  if (!user) {
    throw new AppError("FORBIDDEN", "已存在账号，请联系管理员", {
      details: { code: "REGISTRATION_CLOSED" },
    });
  }

  await touchLastLogin(user.id);
  const session = await issueSession(user.id, meta.userAgent);
  return { user: toAuthUser(user), token: session.token, expiresAt: session.expiresAt };
}

/** 登录：失败文案统一，且同一来源连续失败会限速（AC-11-3、AC-11-8）。 */
export async function login(
  input: LoginInput & { ip: string },
  meta: RequestMeta,
): Promise<SessionGrant> {
  const decision = loginRateLimiter.check(input.ip);
  if (!decision.allowed) {
    throw new AppError("CONFLICT", "尝试次数过多，请稍后再试", {
      status: 429,
      details: { code: "TOO_MANY_ATTEMPTS", retryAfterSeconds: decision.retryAfterSeconds },
    });
  }

  const user = await findUserByEmail(input.email);
  const passwordOk = user && !user.disabledAt ? await verifyPassword(input.password, user.passwordHash) : false;

  if (!user || !passwordOk) {
    loginRateLimiter.recordFailure(input.ip);
    throw AppError.unauthorized("邮箱或密码不正确");
  }

  loginRateLimiter.clear(input.ip);
  await touchLastLogin(user.id);

  const session = await issueSession(user.id, meta.userAgent);
  return { user: toAuthUser(user), token: session.token, expiresAt: session.expiresAt };
}

/** 当前登录用户；cookie 无效、已撤销、已过期都属于未登录。 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const token = await readSessionToken();
  if (!token) return null;

  const session = await findSessionByTokenHash(hashSessionToken(token));
  if (!session || !isSessionUsable(session)) return null;
  if (session.user.disabledAt) return null;

  return toAuthUser(session.user);
}

/** 接口层用：未登录抛 401，由 `route()` 翻译成错误信封。 */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) throw AppError.unauthorized();
  return user;
}

/** 登出：撤销当前会话并清 cookie；没有 cookie 时也当作成功。 */
export async function logoutCurrentSession(): Promise<void> {
  const token = await readSessionToken();
  if (token) {
    const session = await findSessionByTokenHash(hashSessionToken(token));
    if (session && !session.revokedAt) await revokeSession(session.id);
  }
  await clearSessionCookie();
}

/** 重置密码（命令行使用）：写新哈希并撤销该账号全部会话（AC-11-9）。 */
export async function resetPassword(rawEmail: string, newPassword: string): Promise<AuthUser> {
  const parsedEmail = emailSchema.safeParse(rawEmail);
  if (!parsedEmail.success) throw AppError.validationFailed("邮箱格式不正确");

  const user = await findUserByEmail(parsedEmail.data);
  if (!user) throw AppError.notFound(`账号不存在：${parsedEmail.data}`);

  assertPasswordPolicy(user.email, newPassword);
  await updatePasswordHash(user.id, await hashPassword(newPassword));
  await revokeAllSessions(user.id);

  return toAuthUser(user);
}

/** 把签发好的会话写入 cookie（页面与接口共用）。 */
export async function persistSession(grant: SessionGrant): Promise<void> {
  await writeSessionCookie(grant.token, grant.expiresAt);
}
