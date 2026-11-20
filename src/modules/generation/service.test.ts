process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
process.env.AUTH_SECRET ||= "test-secret-that-is-long-enough-for-derivation";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import type { AgentConfigView } from "@/modules/agent-config/view";
import type { StageName, StageStatus } from "./constants";
import type { StageRecord, TaskAgentSnapshots, TaskWithStages } from "./types";

/**
 * 重试的落库语义（AC-FIX-1、AC-FIX-2）：
 * 置回排队是条件更新，只有真正改到行的请求算成功；改到 0 行说明另一条重试抢先，
 * 必须按当前状态返回同一封 `CONFLICT`，`attempts` 不再加。
 *
 * 这里替换掉持久化端口与资源夹模块，只验证 service 的两条分支；真实并发在 e2e 里验证。
 */
vi.mock("./repo", () => ({
  taskStore: {
    findTask: vi.fn(),
    resetStages: vi.fn(),
    findResultByTask: vi.fn(),
  },
}));

vi.mock("@/modules/media-collection/service", () => ({
  getCollection: vi.fn(),
  getCollectionNames: vi.fn(),
  getCollectionAssetCounts: vi.fn(),
}));

vi.mock("@/modules/gateway/service", () => ({
  listGatewayViews: vi.fn(),
}));

vi.mock("@/modules/agent-config/service", () => ({
  listAgentViews: vi.fn(),
  requireAgentSnapshots: vi.fn(),
}));

const { taskStore } = await import("./repo");
const { getCollectionNames, getCollectionAssetCounts } = await import(
  "@/modules/media-collection/service"
);
const { listAgentViews } = await import("@/modules/agent-config/service");
const { listGatewayViews } = await import("@/modules/gateway/service");
const { getTask, retryTask } = await import("./service");

const TASK_ID = "task-1";

function stageRecord(
  stage: StageName,
  status: StageStatus,
  attempts = 1,
): StageRecord {
  return {
    id: `${stage}-stage`,
    taskId: TASK_ID,
    stage,
    status,
    attempts,
    error: null,
    meta: null,
    progress: null,
    startedAt: null,
    finishedAt: null,
  };
}

function agentSnapshot(type: StageName, modelId: string | null = "model-1"): AgentSnapshot {
  return {
    agentType: type,
    enabled: true,
    name: `${type} Agent`,
    gatewayId: "gateway-1",
    protocol: "openai-chat",
    baseUrl: "https://gw.example.com/v1",
    modelId,
    role: "角色",
    systemPrompt: "提示词",
    outputRequirements: "输出要求",
  };
}

const AGENTS: TaskAgentSnapshots = {
  image: agentSnapshot("image"),
  copy: agentSnapshot("copy"),
};

/** 当前 Agent 配置这里只用模型与网关两项，其余字段与重试说明无关。 */
function agentView(type: StageName, modelId: string | null = "model-1"): AgentConfigView {
  return { type, gatewayId: "gateway-1", gatewayModelId: modelId } as AgentConfigView;
}

function taskWith(stages: StageRecord[]): TaskWithStages {
  return {
    task: {
      id: TASK_ID,
      collectionId: "collection-1",
      visualStyle: "fresh",
      copyStyle: "story",
      extraPrompt: null,
      agentSnapshot: AGENTS,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    stages,
  };
}

beforeEach(() => {
  vi.mocked(taskStore.findTask).mockReset();
  vi.mocked(taskStore.resetStages).mockReset();
  vi.mocked(taskStore.findResultByTask).mockReset();
  vi.mocked(taskStore.findResultByTask).mockResolvedValue(null);
  vi.mocked(getCollectionNames).mockReset();
  vi.mocked(getCollectionNames).mockResolvedValue({ "collection-1": "资源夹" });
  vi.mocked(getCollectionAssetCounts).mockReset();
  vi.mocked(getCollectionAssetCounts).mockResolvedValue({ "collection-1": 2 });
  vi.mocked(listGatewayViews).mockReset();
  vi.mocked(listGatewayViews).mockResolvedValue([]);
  vi.mocked(listAgentViews).mockReset();
  vi.mocked(listAgentViews).mockResolvedValue([agentView("image"), agentView("copy")]);
});

describe("retryTask 的并发语义（AC-FIX-1、AC-FIX-2）", () => {
  it("条件更新改到 0 行时按当前状态返回 CONFLICT，不再加 attempts", async () => {
    // 第一条请求读到的还是 partial；它的条件更新被另一条抢先，改到 0 行。
    vi.mocked(taskStore.findTask)
      .mockResolvedValueOnce(taskWith([stageRecord("image", "succeeded"), stageRecord("copy", "failed")]))
      // 落空后重读：文案阶段已经被另一条重试置回排队。
      .mockResolvedValueOnce(taskWith([stageRecord("image", "succeeded"), stageRecord("copy", "queued", 2)]));
    vi.mocked(taskStore.resetStages).mockResolvedValue(0);

    const error = await retryTask(TASK_ID).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({
      code: "CONFLICT",
      details: { code: "NO_FAILED_STAGE", taskStatus: "running" },
    });
    // 只发了一次条件更新：落空之后没有再写库。
    expect(vi.mocked(taskStore.resetStages)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(taskStore.resetStages)).toHaveBeenCalledWith(TASK_ID, ["copy"]);
  });

  it("条件更新改到 1 行时返回任务详情，只重排失败阶段", async () => {
    const retried = taskWith([stageRecord("image", "succeeded"), stageRecord("copy", "queued", 2)]);
    vi.mocked(taskStore.findTask)
      // 读到的仍是重试前的 partial。
      .mockResolvedValueOnce(taskWith([stageRecord("image", "succeeded"), stageRecord("copy", "failed")]))
      // 条件更新成功后重读，拿到已重新排队的阶段。
      .mockResolvedValue(retried);
    vi.mocked(taskStore.resetStages).mockResolvedValue(1);

    const detail = await retryTask(TASK_ID);

    expect(vi.mocked(taskStore.resetStages)).toHaveBeenCalledWith(TASK_ID, ["copy"]);
    expect(detail.stages.copy).toMatchObject({ status: "queued", attempts: 2 });
    expect(detail.stages.image).toMatchObject({ status: "succeeded", attempts: 1 });
  });
});

/** 重试说明的取值来自快照与当前 Agent 配置的比较（MKACG-904 SHOULD）。 */
describe("任务视图带上的重试说明（MKACG-904）", () => {
  it("失败阶段的快照与当前配置一致时用普通说明", async () => {
    vi.mocked(taskStore.findTask).mockResolvedValue(
      taskWith([stageRecord("image", "failed"), stageRecord("copy", "queued")]),
    );

    const detail = await getTask(TASK_ID);

    expect(detail.retryHint).toMatchObject({ state: "snapshot" });
    expect(detail.retryHint?.message).toContain("重新生成");
  });

  it("当前配置换过模型时换成警示说明", async () => {
    vi.mocked(taskStore.findTask).mockResolvedValue(
      taskWith([stageRecord("image", "failed"), stageRecord("copy", "queued")]),
    );
    vi.mocked(listAgentViews).mockResolvedValue([
      agentView("image", "another-image-model"),
      agentView("copy"),
    ]);

    const detail = await getTask(TASK_ID);

    expect(detail.retryHint).toMatchObject({ state: "snapshot-changed" });
    expect(detail.retryHint?.message).toContain("快照用的模型或网关与当前 Agent 配置不同");
  });

  it("没有失败阶段时详情不给重试说明", async () => {
    vi.mocked(taskStore.findTask).mockResolvedValue(
      taskWith([stageRecord("image", "succeeded"), stageRecord("copy", "succeeded")]),
    );

    const detail = await getTask(TASK_ID);

    expect(detail.retryHint).toBeNull();
  });
});
