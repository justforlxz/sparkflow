import { TASK_COPY } from "@/modules/generation/constants";
import { listTasks } from "@/modules/generation/service";
import { TaskList } from "./task-list";

export const dynamic = "force-dynamic";

/** `/tasks`：任务列表（docs/prd/07「任务列表」）。数据由服务端先取一次，客户端只在未终态时轮询。 */
export default async function TasksPage() {
  const tasks = await listTasks();

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-zinc-900">{TASK_COPY.listTitle}</h1>
        <p className="text-sm text-zinc-600">{TASK_COPY.listSubtitle}</p>
      </div>
      <TaskList initialTasks={tasks} />
    </section>
  );
}
