export default function HomePage() {
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-zinc-900">项目骨架已就绪</h1>
        <p className="max-w-2xl text-sm leading-6 text-zinc-600">
          本版本只交付工程基线：数据库迁移、统一错误信封、脱敏日志、功能开关机制与容器部署。
          业务功能由后续节点按 Issue 逐个补齐。
        </p>
      </div>
      <dl className="grid gap-3 text-sm text-zinc-600 sm:grid-cols-2">
        <div className="flex items-baseline gap-2">
          <dt className="font-medium text-zinc-900">健康检查</dt>
          <dd>
            <code>GET /api/health</code>
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="font-medium text-zinc-900">功能开关</dt>
          <dd>
            <code>GET /api/features</code>
          </dd>
        </div>
      </dl>
    </section>
  );
}
