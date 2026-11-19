/**
 * 创作任务业务层：接口与页面只调用这里的函数（docs/prd/04-generation-task.md、ADR 0005）。
 *
 * 边界：
 * 1. 创建任务前依次校验「资源夹存在且有图片」与「两个 Agent 就绪」；任一不满足都不写任务记录。
 * 2. 快照只从 agent-config 模块取（MUST 6），本模块不拼提示词、不读网关密钥。
 * 3. 重试只重置失败阶段，判定在 `derive.ts` 的 `planStagesToRetry`。
 */
import { AppError } from "@/lib/errors";
import { listAgentViews, requireAgentSnapshots } from "@/modules/agent-config/service";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import { listGatewayViews } from "@/modules/gateway/service";
import type { GatewayView } from "@/modules/gateway/view";
import { getCollection, getCollectionNames } from "@/modules/media-collection/service";
import { STAGE_LABELS, STAGE_NAMES, type StageName } from "./constants";
import {
  planStagesToRetry,
  throwRetryConflict,
  type AgentBindingState,
} from "./derive";
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

/**
 * 当前两份 Agent 配置的绑定（只看模型与网关）：任务快照与它不同，说明创建之后改过配置，
 * 失败阶段的重试提示要换成警示样式（MKACG-904 SHOULD）。阶段名与 Agent 类型同名，
 * 缺一份说明迁移没跑或返回形状变了，属部署问题，不当成「没有改动」处理。
 */
async function currentAgentBindings(
  gateways: readonly GatewayView[],
): Promise<Record<StageName, AgentBindingState>> {
  const views = new Map((await listAgentViews(gateways)).map((view) => [view.type, view]));

  const bindings = {} as Record<StageName, AgentBindingState>;
  for (const name of STAGE_NAMES) {
    const view = views.get(name);
    if (!view) {
      throw new AppError(
        "INTERNAL",
        `Agent 配置缺失：${STAGE_LABELS[name]}，无法判断任务快照是否已过时`,
      );
    }
    bindings[name] = { gatewayId: view.gatewayId, modelId: view.gatewayModelId };
  }
  return bindings;
}

async function buildDetail(taskId: string): Promise<TaskDetailView> {
  const record = await taskStore.findTask(taskId);
  if (!record) throw AppError.notFound("创作任务不存在");

  const [result, names, gateways] = await Promise.all([
    taskStore.findResultByTask(taskId),
    getCollectionNames([record.task.collectionId]),
    listGatewayViews(),
  ]);
  // 资源夹被删时任务随外键级联删除，取不到名称说明数据已损坏，不编造占位文案。
  const collectionName = names[record.task.collectionId];
  if (!collectionName) {
    throw new AppError("INTERNAL", "创作任务所属的资源夹不存在，请检查数据写入路径");
  }
  return toTaskDetailView(record, result, collectionName, await currentAgentBindings(gateways));
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
  const [snapshots, currentAgents] = await Promise.all([
    requireAgentSnapshots(gateways),
    currentAgentBindings(gateways),
  ]);
  const agents = toAgentSnapshots(snapshots);

  const created = await taskStore.createTask({
    collectionId,
    visualStyle: input.visualStyle,
    copyStyle: input.copyStyle,
    imageCount: input.imageCount,
    extraPrompt: input.extraPrompt ?? null,
    agentSnapshot: agents,
  });

  return toTaskDetailView(created, null, collection.name, currentAgents);
}

/** 任务列表：带上资源夹名（列表要显示它），一次批量取，避免逐行查询。 */
export async function listTasks(): Promise<TaskSummaryView[]> {
  const [records, gateways] = await Promise.all([taskStore.listTasks(), listGatewayViews()]);
  const [names, currentAgents] = await Promise.all([
    getCollectionNames(records.map((record) => record.task.collectionId)),
    currentAgentBindings(gateways),
  ]);

  return records.map((record) => {
    const collectionName = names[record.task.collectionId];
    if (!collectionName) {
      throw new AppError("INTERNAL", "创作任务所属的资源夹不存在，请检查数据写入路径");
    }
    return toTaskSummaryView(record, collectionName, currentAgents);
  });
}

export async function getTask(taskId: string): Promise<TaskDetailView> {
  return buildDetail(taskId);
}

/**
 * 重试（ADR 0005、AC-04-6 ~ AC-04-8、AC-05-12）：
 * 只把失败阶段置回排队并让 `attempts` 加一；已成功阶段的产出与次数都不动。
 * 没有失败阶段（全部成功、还在跑、已排队）一律 `CONFLICT`，不会重复入队。
 *
 * 同时到达的两条重试只有一个能真正入队：置回排队是条件更新（`status` 必须还是 failed），
 * 另一条拿到 0 行，按重读到的当前状态返回同一封信，`attempts` 因此只加一次。
 */
export async function retryTask(taskId: string): Promise<TaskDetailView> {
  const record = await taskStore.findTask(taskId);
  if (!record) throw AppError.notFound("创作任务不存在");

  const stages = planStagesToRetry(record.stages);
  const reset = await taskStore.resetStages(taskId, stages);
  if (reset === 0) {
    const current = await taskStore.findTask(taskId);
    if (!current) throw AppError.notFound("创作任务不存在");
    throwRetryConflict(current.stages);
  }

  return buildDetail(taskId);
}
