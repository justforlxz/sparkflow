import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "@/modules/agent-config/snapshot";
import type { ResultRecord, StageRecord, TaskWithStages } from "./types";
import { toResultView, toTaskSummaryView } from "./view";

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

function stage(stage: "image" | "copy", status: StageRecord["status"]): StageRecord {
  return {
    id: `${stage}-1`,
    taskId: "task-1",
    stage,
    status,
    attempts: 1,
    error: null,
    meta: null,
    startedAt: null,
    finishedAt: null,
  };
}

function taskWithStages(stages: StageRecord[]): TaskWithStages {
  return {
    task: {
      id: "task-1",
      collectionId: "collection-1",
      visualStyle: "fresh",
      copyStyle: "story",
      imageCount: 4,
      extraPrompt: null,
      agentSnapshot: { image: SNAPSHOT, copy: SNAPSHOT },
      createdAt: new Date("2026-11-18T02:00:00.000Z"),
    },
    stages,
  };
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
      { id: "asset-1", fileName: "1.png", mimeType: "image/png", sortOrder: 0 },
      { id: "asset-2", fileName: "2.png", mimeType: "image/png", sortOrder: 1 },
    ],
    ...overrides,
  };
}

describe("任务列表视图", () => {
  it("两条阶段各自给出状态标签，并且带上资源夹名与中文风格名", () => {
    const view = toTaskSummaryView(
      taskWithStages([stage("image", "succeeded"), stage("copy", "failed")]),
      "我的资源夹",
    );

    expect(view.collectionName).toBe("我的资源夹");
    expect(view.status).toBe("partial");
    expect(view.statusLabel).toBe("部分完成");
    expect(view.visualStyleLabel).toBe("清新生活感");
    expect(view.copyStyleLabel).toBe("故事分享");
    expect(view.stages.image).toMatchObject({ label: "生图阶段", statusLabel: "已完成" });
    expect(view.stages.copy).toMatchObject({ label: "文案阶段", statusLabel: "失败" });
  });

  it("认不出的风格 key 原样显示，不编造中文名", () => {
    const record = taskWithStages([stage("image", "queued"), stage("copy", "queued")]);
    record.task = { ...record.task, visualStyle: "unknown", copyStyle: "unknown" };

    const view = toTaskSummaryView(record, "资源夹");

    expect(view.visualStyleLabel).toBe("unknown");
    expect(view.copyStyleLabel).toBe("unknown");
  });

  it("缺一条阶段记录时报内部错误，不当成空状态", () => {
    expect(() => toTaskSummaryView(taskWithStages([stage("image", "succeeded")]), "资源夹")).toThrow(
      /任务缺少 文案阶段记录/,
    );
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

  it("两个阶段都成功时不标记失败，标题正文原样返回", () => {
    const view = toResultView(result(), [
      stage("image", "succeeded"),
      stage("copy", "succeeded"),
    ]);

    expect(view.copyFailed).toBe(false);
    expect(view.title).toBe("标题");
    expect(view.body).toBe("正文");
    expect(view.tags).toEqual(["咖啡"]);
    expect(view.visualStyleLabel).toBe("清新生活感");
    expect(view.taskId).toBe("task-1");
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
