/**
 * 创作任务业务层：接口与页面只调用这里的函数（docs/prd/04-generation-task.md、ADR 0005）。
 *
 * 边界：
 * 1. 创建任务前依次校验「资源夹存在且有图片」与「两个 Agent 就绪」；任一不满足都不写任务记录。
 * 2. 快照只从 agent-config 模块取（MUST 6），本模块不拼提示词、不读网关密钥。
 * 3. 重试只重置失败阶段，判定在 `derive.ts` 的 `planStagesToRetry`。
 */
import { AppError } from "@/lib/errors";
import { requireAgentSnapshots } from "@/modules/agent-config/service";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import { listGatewayViews } from "@/modules/gateway/service";
import { getCollection } from "@/modules/media-collection/service";
import { planStagesToRetry } from "./derive";
import { taskStore } from "./repo";
import { assertCollectionHasImages } from "./rules";
import type { CreateTaskInput } from "./schema";
import type { TaskAgentSnapshots } from "./types";
import {
  toTaskDetailView,
  toTaskSummaryView,
  type TaskDetailView,
  type TaskSummaryView,
} from "./view";

/** 就绪校验保证两份都在；缺一份说明 agent-config 的返回形状变了。 */
function toAgentSnapshots(snapshots: readonly AgentSnapshot[]): TaskAgentSnapshots {
  const image = snapshots.find((snapshot) => snapshot.agentType === "image");
  const copy = snapshots.find((snapshot) => snapshot.agentType === "copy");
  if (!image || !copy) {
    throw new AppError("INTERNAL", "Agent 配置快照缺失：需要图片与文案两份");
  }
  return { image, copy };
}

async function buildDetail(taskId: string): Promise<TaskDetailView> {
  const record = await taskStore.findTask(taskId);
  if (!record) throw AppError.notFound("创作任务不存在");
  const result = await taskStore.findResultByTask(taskId);
  return toTaskDetailView(record, result);
}

/**
 * 创建任务（= 重新生成的能力，AC-04-9）：只写库并立即返回，执行交给 worker。
 * 两个 Agent 未就绪时抛 `CONFLICT` + `AGENT_NOT_READY`，且不产生任务记录（AC-04-4）。
 */
export async function createTask(
  collectionId: string,
  input: CreateTaskInput,
): Promise<TaskDetailView> {
  const collection = await getCollection(collectionId);
  assertCollectionHasImages(collection.assetCount);

  const gateways = await listGatewayViews();
  const agents = toAgentSnapshots(await requireAgentSnapshots(gateways));

  const created = await taskStore.createTask({
    collectionId,
    visualStyle: input.visualStyle,
    copyStyle: input.copyStyle,
    imageCount: input.imageCount,
    extraPrompt: input.extraPrompt ?? null,
    agentSnapshot: agents,
  });

  return toTaskDetailView(created, null);
}

export async function listTasks(): Promise<TaskSummaryView[]> {
  const records = await taskStore.listTasks();
  return records.map(toTaskSummaryView);
}

export async function getTask(taskId: string): Promise<TaskDetailView> {
  return buildDetail(taskId);
}

/**
 * 重试（ADR 0005、AC-04-6 ~ AC-04-8、AC-05-12）：
 * 只把失败阶段置回排队并让 `attempts` 加一；已成功阶段的产出与次数都不动。
 * 没有失败阶段（全部成功、还在跑、已排队）一律 `CONFLICT`，不会重复入队。
 */
export async function retryTask(taskId: string): Promise<TaskDetailView> {
  const record = await taskStore.findTask(taskId);
  if (!record) throw AppError.notFound("创作任务不存在");

  const stages = planStagesToRetry(record.stages);
  await taskStore.resetStages(taskId, stages);

  return buildDetail(taskId);
}
