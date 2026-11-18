/**
 * 进程启动钩子：先把环境变量校验跑一遍，再确保磁盘存储目录存在，最后启动生成任务 worker。
 * 校验失败直接抛错，进程起不来 —— 不带错误配置接流量。
 *
 * 构建阶段不会执行 `register()`（CI 的 `pnpm build` 没有数据库与密钥），因此这里可以直接连库。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const [{ getEnv }, { ensureStorageRoot }, { startTaskWorker }] = await Promise.all([
    import("./lib/env"),
    import("./lib/storage"),
    import("./modules/generation/worker"),
  ]);

  getEnv();
  await ensureStorageRoot();
  // 生成任务用进程内 worker 执行（ADR 0002）：启动时清理残留 running，然后轮询 queued 阶段。
  startTaskWorker();
}
