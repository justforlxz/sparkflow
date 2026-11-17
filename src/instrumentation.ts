/**
 * 进程启动钩子：先把环境变量校验跑一遍，再确保磁盘存储目录存在。
 * 校验失败直接抛错，进程起不来 —— 不带错误配置接流量。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const [{ getEnv }, { ensureStorageRoot }] = await Promise.all([
    import("./lib/env"),
    import("./lib/storage"),
  ]);

  getEnv();
  await ensureStorageRoot();
}
