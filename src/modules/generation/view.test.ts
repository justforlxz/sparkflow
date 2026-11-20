import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import type { ResultRecord, StageRecord, TaskWithStages } from "./types";
import { toResultView as toResultViewWithTarget, toTaskSummaryView } from "./view";

/**
 * 任务与结果的对外形状（docs/prd/07「任务列表」「结果页签」）：
 * 界面不再自己判断状态与文案，因此这些派生值必须有单测固定住。
 */

const SNAPSHOT: AgentSnapshot = {
  agentType: "image",
  enabled: true,
  name: "图片 Agent",
  gatewayId: "gateway-1",
  protocol: "openai-chat",
  baseUrl: "https://gw.example.com/v1",
  modelId: null,
  role: "设计",
  systemPrompt: "生成图片",
  outputRequirements: "竖版",
};

/** 当前 Agent 配置的绑定：默认与快照一致，用来验证重试说明的普通样式。 */
const CURRENT_AGENTS = {
  image: { gatewayId: SNAPSHOT.gatewayId, modelId: SNAPSHOT.modelId },
  copy: { gatewayId: SNAPSHOT.gatewayId, modelId: SNAPSHOT.modelId },
};

function stage(stage: "image" | "copy", status: StageRecord["status"]): StageRecord {
  return {
    id: `${stage}-1`,
    taskId: "task-1",
    stage,
    status,
    attempts: 1,
    error: null,
    meta: null,
    progress: null,
    startedAt: null,
    finishedAt: null,
  };
}

function taskWithStages(stages: StageRecord[]): TaskWithStages {
  return {
    task: {
      id: "task-1",
      collectionId: "collection-1",
      extractRequirement: "faithful",
      copyStyle: "story",
      extraPrompt: null,
      agentSnapshot: { image: SNAPSHOT, copy: SNAPSHOT, extractTarget: "桌垫的织物纹理" },
      createdAt: new Date("2026-11-18T02:00:00.000Z"),
    },
    stages,
  };
}

/**
 * 结果视图的第三个入参是任务快照里的提取目标：这些用例不关心它，统一传 null。
 * 需要断言提取目标透传的用例直接调 `toResultViewWithTarget`。
 */
function toResultView(result: ResultRecord, stages: readonly StageRecord[]) {
  return toResultViewWithTarget(result, stages, null);
}

function result(overrides: Partial<ResultRecord> = {}): ResultRecord {
  return {
    id: "result-1",
    taskId: "task-1",
    collectionId: "collection-1",
    title: "标题",
    body: "正文",
    tags: ["咖啡"],
    visualStyle: "fresh",
    createdAt: new Date("2026-11-18T02:00:00.000Z"),
    assets: [
      {
        id: "asset-1",
        fileName: "1.png",
        mimeType: "image/png",
        sortOrder: 1,
        sourceAssetId: "source-1",
      },
      {
        id: "asset-2",
        fileName: "2.png",
        mimeType: "image/png",
        sortOrder: 2,
        sourceAssetId: "source-2",
      },
    ],
    ...overrides,
  };
}

describe("任务列表视图", () => {
  it("两条阶段各自给出状态标签，并且带上资源夹名与中文风格名", () => {
    const view = toTaskSummaryView(
      taskWithStages([stage("image", "succeeded"), stage("copy", "failed")]),
      "我的资源夹",
      CURRENT_AGENTS,
      2,
    );

    expect(view.collectionName).toBe("我的资源夹");
    expect(view.status).toBe("partial");
    expect(view.statusLabel).toBe("部分完成");
    expect(view.extractRequirementLabel).toBe("忠实还原");
    expect(view.extractTarget).toBe("桌垫的织物纹理");
    expect(view.copyStyleLabel).toBe("故事分享");
    expect(view.stages.image).toMatchObject({ label: "生图阶段", statusLabel: "已完成" });
    expect(view.stages.copy).toMatchObject({ label: "文案阶段", statusLabel: "失败" });
  });

  it("认不出的提取要求 key 原样显示，不编造中文名", () => {
    const record = taskWithStages([stage("image", "queued"), stage("copy", "queued")]);
    record.task = { ...record.task, extractRequirement: "unknown", copyStyle: "unknown" };

    const view = toTaskSummaryView(record, "资源夹", CURRENT_AGENTS, 2);

    expect(view.extractRequirementLabel).toBe("unknown");
    expect(view.copyStyleLabel).toBe("unknown");
  });

  it("缺一条阶段记录时报内部错误，不当成空状态", () => {
    expect(() =>
      toTaskSummaryView(
        taskWithStages([stage("image", "succeeded")]),
        "资源夹",
        CURRENT_AGENTS,
        2,
      ),
    ).toThrow(/任务缺少 文案阶段记录/);
  });

  it("有失败阶段时给出重试说明，没有失败阶段时不给（MKACG-904）", () => {
    const failed = toTaskSummaryView(
      taskWithStages([stage("image", "succeeded"), stage("copy", "failed")]),
      "资源夹",
      CURRENT_AGENTS,
      2,
    );
    expect(failed.retryHint?.state).toBe("snapshot");
    expect(failed.retryHint?.message).toContain("沿用该任务创建时的 Agent 配置");
    expect(failed.retryHint?.message).toContain("重新生成");

    const succeeded = toTaskSummaryView(
      taskWithStages([stage("image", "succeeded"), stage("copy", "succeeded")]),
      "资源夹",
      CURRENT_AGENTS,
      2,
    );
    expect(succeeded.retryHint).toBeNull();
  });

  it("失败阶段的快照与当前配置不同时换成警示文案（MKACG-904）", () => {
    const view = toTaskSummaryView(
      taskWithStages([stage("image", "failed"), stage("copy", "queued")]),
      "资源夹",
      {
        ...CURRENT_AGENTS,
        image: { gatewayId: SNAPSHOT.gatewayId, modelId: "sensenova-u1.5-lite" },
      },
      2,
    );

    expect(view.retryHint?.state).toBe("snapshot-changed");
    expect(view.retryHint?.message).toContain("快照用的模型或网关与当前 Agent 配置不同");
    expect(view.retryHint?.message).toContain("重新生成");
  });
});

describe("结果视图", () => {
  it("文案阶段失败时标记 copyFailed 并给出 partial 状态，供界面显示提示与重试入口", () => {
    const view = toResultView(result({ title: null, body: null, tags: [] }), [
      stage("image", "succeeded"),
      stage("copy", "failed"),
    ]);

    expect(view.copyFailed).toBe(true);
  });

  it("AC-06-8 降级原因分两种：没配置理解网关 / 识别失败，各自给一句可操作的话", () => {
    const withoutGateway = toResultView(result(), [
      { ...stage("image", "succeeded") },
      { ...stage("copy", "succeeded"), meta: { visualExtraction: "skipped-no-vision-gateway" } },
    ]);
    expect(withoutGateway.copyVisualDegraded).toBe(true);
    expect(withoutGateway.copyVisualDegradedHint).toContain("请到设置页添加");

    const failed = toResultView(result(), [
      stage("image", "succeeded"),
      { ...stage("copy", "succeeded"), meta: { visualExtraction: "skipped-vision-failed" } },
    ]);
    expect(failed.copyVisualDegradedHint).toContain("可重试文案阶段");

    const ok = toResultView(result(), [
      stage("image", "succeeded"),
      { ...stage("copy", "succeeded"), meta: { visualExtraction: "done" } },
    ]);
    expect(ok.copyVisualDegraded).toBe(false);
    expect(ok.copyVisualDegradedHint).toBeNull();
  });

  it("两个阶段都成功时不标记失败，标题正文原样返回", () => {
    const view = toResultView(result(), [
      stage("image", "succeeded"),
      stage("copy", "succeeded"),
    ]);

    expect(view.copyFailed).toBe(false);
    expect(view.title).toBe("标题");
    expect(view.body).toBe("正文");
    expect(view.tags).toEqual(["咖啡"]);
    // 历史结果存的是旧的视觉方向 key（fresh）：不做数据迁移，仍显示当时的中文名。
    expect(view.visualStyleLabel).toBe("清新生活感");
    expect(view.taskId).toBe("task-1");
  });

  it("AC-EX-4 结果摘要带上任务快照的提取目标，新结果的视觉风格显示新登记表的中文名", () => {
    const stages = [stage("image", "succeeded"), stage("copy", "succeeded")];
    const view = toResultViewWithTarget(
      result({ visualStyle: "flatten" }),
      stages,
      "桌垫的织物纹理",
    );

    expect(view.extractTarget).toBe("桌垫的织物纹理");
    expect(view.visualStyleLabel).toBe("平整化");

    // 历史结果没有提取目标（ADR 0009 之前的任务快照没有这一项）：如实给 null，界面显示占位。
    expect(toResultViewWithTarget(result(), stages, null).extractTarget).toBeNull();
  });

  it("生成图片给出原图与缩略图两个鉴权地址，缩略图统一 400 宽", () => {
    const view = toResultView(result(), [stage("image", "succeeded"), stage("copy", "succeeded")]);

    expect(view.assets[0]).toMatchObject({
      id: "asset-1",
      url: "/api/files/generated/result-1/asset-1",
      thumbnailUrl: "/api/files/generated/result-1/asset-1?w=400",
    });
    expect(view.assets.map((asset) => asset.id)).toEqual(["asset-1", "asset-2"]);
  });
});
