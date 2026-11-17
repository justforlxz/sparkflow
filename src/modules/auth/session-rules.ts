/** 会话是否仍然可用（纯函数，便于单测 AC-11-7）。 */
export interface SessionState {
  expiresAt: Date;
  revokedAt: Date | null;
}

export function isSessionUsable(session: SessionState, now: Date = new Date()): boolean {
  if (session.revokedAt) return false;
  return session.expiresAt.getTime() > now.getTime();
}
