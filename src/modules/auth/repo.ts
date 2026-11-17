/** 账号与会话的持久化访问。判断逻辑不在这里。 */
import { getDb } from "@/lib/db";

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  disabledAt: Date | null;
}

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  passwordHash: true,
  disabledAt: true,
} as const;

export async function countUsers(): Promise<number> {
  return getDb().user.count();
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  return getDb().user.findUnique({ where: { email }, select: USER_SELECT });
}

/**
 * 创建第一个账号。在 Serializable 事务里「检查数量 + 写入」，
 * 空库时两个并发请求不会都成功；已有账号（或并发冲突）返回 null。
 */
export async function createFirstUser(input: {
  email: string;
  name: string;
  passwordHash: string;
}): Promise<UserRecord | null> {
  try {
    return await getDb().$transaction(
      async (tx) => {
        const existing = await tx.user.count();
        if (existing > 0) return null;
        return await tx.user.create({ data: input, select: USER_SELECT });
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    // P2034：事务写冲突（并发注册），按「已存在账号」处理。
    if ((error as { code?: string }).code === "P2034") return null;
    throw error;
  }
}

export async function updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
  await getDb().user.update({ where: { id: userId }, data: { passwordHash } });
}

export async function touchLastLogin(userId: string, at: Date = new Date()): Promise<void> {
  await getDb().user.update({ where: { id: userId }, data: { lastLoginAt: at } });
}

export interface SessionWithUser {
  id: string;
  expiresAt: Date;
  revokedAt: Date | null;
  user: UserRecord;
}

export async function createSession(input: {
  tokenHash: string;
  userId: string;
  expiresAt: Date;
  userAgent: string | null;
}): Promise<void> {
  await getDb().session.create({ data: input });
}

export async function findSessionByTokenHash(tokenHash: string): Promise<SessionWithUser | null> {
  return getDb().session.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      user: { select: USER_SELECT },
    },
  });
}

export async function revokeSession(sessionId: string, at: Date = new Date()): Promise<void> {
  await getDb().session.update({ where: { id: sessionId }, data: { revokedAt: at } });
}

export async function revokeAllSessions(userId: string, at: Date = new Date()): Promise<void> {
  await getDb().session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: at },
  });
}
