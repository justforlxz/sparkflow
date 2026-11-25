"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "@/components/api";
import { Pill } from "@/components/ui/Pill";
import { COLLECTION_STATUS_TONE, EXTRACTION_STATUS_TONE } from "@/components/ui/status-tone";
import { PAGE_SUBTITLE_CLASS, PAGE_TITLE_CLASS, TEXT_LINK_CLASS } from "@/components/ui/styles";
import { SELECTABLE_CATEGORIES } from "@/modules/extraction/categories";
import { EXTRACTION_POLL_INTERVAL_MS, LIBRARY_COPY } from "@/modules/extraction/constants";
import {
  buildResultCards,
  type ResultCardView,
  type ResultCellRetry,
} from "@/modules/extraction/results";
import { isActiveRun, progressPercent, runFailureText } from "@/modules/extraction/summary";
import type { ExtractionRunView, LibraryView } from "@/modules/extraction/view";
import { EXTRACT_REQUIREMENTS } from "@/modules/image-generation/styles";
import { COLLECTION_COPY, COLLECTION_STATUS_LABELS } from "@/modules/media-collection/constants";
import type { CollectionDetailView } from "@/modules/media-collection/service";
import { CollectionDialog } from "../collection-dialog";
import { DeleteCollectionButton } from "./delete-collection-button";
import { SettingsColumn } from "./extraction-settings-panel";
import { ResultCards, resultCellKey } from "./result-cards";
import { SourceAssetsPanel } from "./source-assets-panel";

/**
 * 资源夹详情的三栏工作区（ADR 0012 第 4 条、MKACG-974 AC-UI-1 ~ AC-UI-10）。
 *
 * 宽屏（≥1240px）三栏：左 232 原始材料 / 中自适应（≥600）处理结果 / 右 268 提取设置，
 * **整页锁高度**（`body{overflow:hidden}` + 容器 `100vh`），只有中列滚动；
 * 窄屏回落单列流式（素材 → 结果 → 设置），页面正常滚动。
 *
 * 状态都收在这里：提取运行、素材库、选中哪几张、条件与额外补充。
 * 有未终态运行时按 `EXTRACTION_POLL_INTERVAL_MS` 轮询；全部进终态后拉一次素材库并刷新页面计数。
 * 「按原图一张卡」的派生读法在 `modules/extraction/results.ts`（纯函数 + 单测），界面只消费它。
 */
export interface CollectionWorkspaceProps {
  collection: CollectionDetailView;
  initialRuns: ExtractionRunView[];
  initialLibrary: LibraryView;
}

const ALL_CATEGORIES = SELECTABLE_CATEGORIES.map((category) => category.value);

export function CollectionWorkspace({
  collection,
  initialRuns,
  initialLibrary,
}: CollectionWorkspaceProps) {
  const router = useRouter();
  // 原图清单以服务端为准（编辑弹窗保存、添加弹窗确认后 `router.refresh()` 会送来新的一份）。
  const assets = collection.assets;
  // 选择只记「用户取消过哪几张」：新加进来的原图自动是选中的，从夹里移除的原图自动消失，
  // 不需要在图片增删后再修一遍选择状态。
  const [deselected, setDeselected] = useState<Set<string>>(() => new Set());
  const selected = useMemo(
    () => new Set(assets.filter((asset) => !deselected.has(asset.id)).map((asset) => asset.id)),
    [assets, deselected],
  );
  const [runs, setRuns] = useState(initialRuns);
  const [library, setLibrary] = useState(initialLibrary);
  const [requirement, setRequirement] = useState<string>(EXTRACT_REQUIREMENTS[0].value);
  const [extraPrompt, setExtraPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  // 整页锁高度只对宽屏生效（AC-UI-1）：窄屏是单列流式，页面要能正常滚动（AC-UI-3、AC-UI-10）。
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1240px)");
    function apply() {
      document.body.style.overflow = wide.matches ? "hidden" : "";
    }
    apply();
    wide.addEventListener("change", apply);
    return () => {
      wide.removeEventListener("change", apply);
      document.body.style.overflow = "";
    };
  }, []);

  const activeRuns = useMemo(() => runs.filter(isActiveRun), [runs]);
  const activeRun = activeRuns[0] ?? null;
  const latestRun = runs[0] ?? null;
  const polling = activeRuns.length > 0;

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      fetchJson<{ runs: ExtractionRunView[] }>(`/api/collections/${collection.id}/extractions`)
        .then((data) => {
          if (cancelled) return;
          setRuns(data.runs);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setError(cause instanceof Error ? cause.message : "提取进度更新失败");
        });
    }, EXTRACTION_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [polling, collection.id]);

  // 从「有进行中」变成「全部终态」时刷新素材库与页面计数；首次渲染不触发。
  const hadActiveRun = useRef(polling);
  useEffect(() => {
    const wasPolling = hadActiveRun.current;
    hadActiveRun.current = polling;
    if (!wasPolling || polling) return;

    let cancelled = false;
    fetchJson<LibraryView>(`/api/collections/${collection.id}/library`)
      .then((data) => {
        if (cancelled) return;
        setLibrary(data);
        // 全部进终态后「重试中」的格子由真实结果接管，本地标记可以清掉。
        setRetrying(new Set());
        router.refresh();
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "素材库刷新失败");
      });

    return () => {
      cancelled = true;
    };
  }, [polling, collection.id, router]);

  // 结果卡：纯函数算出「每张原图的三类产出」，再叠加本地点了「重试」但运行还没回来的格子。
  const cards = useMemo(() => {
    const built = buildResultCards({ sourceAssets: assets, library, runs });
    if (retrying.size === 0) return built;

    return built.map((card) => ({
      ...card,
      cells: card.cells.map((cell) =>
        cell.state !== "done" && retrying.has(resultCellKey(card.sourceAssetId, cell.category))
          ? { ...cell, state: "pending" as const, asset: null, reason: null, retry: null }
          : cell,
      ),
    }));
  }, [assets, library, runs, retrying]);

  function toggleAsset(assetId: string): void {
    setDeselected((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  function toggleAll(): void {
    // 全选 = 清空「取消过」的清单；再点一次 = 全部取消。
    setDeselected(selected.size === assets.length ? new Set(assets.map((a) => a.id)) : new Set());
  }

  const startExtraction = useCallback(
    async (body: {
      sourceAssetIds: string[];
      categories: string[];
      requirement: string;
      extraPrompt?: string;
    }): Promise<void> => {
      const data = await fetchJson<{ run: ExtractionRunView }>(
        `/api/collections/${collection.id}/extractions`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setRuns((current) => [data.run, ...current]);
    },
    [collection.id],
  );

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      // 按资源夹里的原图顺序提交，勾选顺序不影响调用顺序；类别固定三类。
      const sourceAssetIds = assets
        .filter((asset) => selected.has(asset.id))
        .map((asset) => asset.id);
      await startExtraction({
        sourceAssetIds,
        categories: ALL_CATEGORIES,
        requirement,
        extraPrompt: extraPrompt.trim() === "" ? undefined : extraPrompt,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发起提取失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function retryCell(cell: ResultCellRetry): Promise<void> {
    const key = resultCellKey(cell.sourceAssetId, cell.category);
    // 先把这一格标成「重试中」：运行创建接口返回前也有反馈，不必等下一次轮询。
    setRetrying((current) => new Set(current).add(key));
    setError(null);
    try {
      await startExtraction({
        sourceAssetIds: [cell.sourceAssetId],
        categories: [cell.category],
        requirement: cell.requirement,
      });
    } catch (cause) {
      setRetrying((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      setError(cause instanceof Error ? cause.message : "重试失败");
    }
  }

  async function rerunCard(card: ResultCardView): Promise<void> {
    setError(null);
    try {
      await startExtraction({
        sourceAssetIds: [card.sourceAssetId],
        categories: ALL_CATEGORIES,
        requirement: card.requirement ?? requirement,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重跑失败");
    }
  }

  const percent = progressPercent(activeRun?.progress ?? null);
  const failureText = latestRun ? runFailureText(latestRun) : null;

  return (
    <section
      data-testid="collection-workspace"
      className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 min-[1240px]:h-[calc(100vh-5rem)]"
    >
      <div className="space-y-2">
        <Link href="/collections" className={`text-footnote ${TEXT_LINK_CLASS}`}>
          ← {COLLECTION_COPY.listTitle}
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className={PAGE_TITLE_CLASS}>{collection.name}</h1>
          <div className="flex flex-wrap items-start gap-2">
            <CollectionDialog
              mode="edit"
              collection={{
                id: collection.id,
                values: {
                  name: collection.name,
                  platform: collection.platform ?? "",
                  sourceUrl: collection.sourceUrl ?? "",
                  sourceTitle: collection.sourceTitle ?? "",
                  sourceBody: collection.sourceBody ?? "",
                },
                assets,
              }}
            />
            <DeleteCollectionButton collectionId={collection.id} />
          </div>
        </div>

        <div
          data-testid={latestRun && !polling ? "extraction-run" : undefined}
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${PAGE_SUBTITLE_CLASS}`}
        >
          {activeRun ? (
            <span data-testid="inline-progress" className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-ink">{LIBRARY_COPY.inlineProgressLabel}</span>
              <span
                role="progressbar"
                aria-label={LIBRARY_COPY.inlineProgressLabel}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                data-testid="inline-progress-bar"
                className="shimmer relative h-2 w-40 overflow-hidden rounded-sm bg-soft"
              >
                <span
                  className="block h-full rounded-sm bg-accent transition-[width] duration-[350ms] ease-out"
                  style={{ width: `${percent}%` }}
                />
              </span>
              <span data-testid="inline-progress-text" className="shrink-0 text-ink-secondary">
                {percent}%
              </span>
            </span>
          ) : latestRun ? (
            <>
              <Pill tone={EXTRACTION_STATUS_TONE[latestRun.status]}>{latestRun.statusLabel}</Pill>
              {failureText ? <span className="text-warning">{failureText}</span> : null}
              {latestRun.error ? (
                <span className="min-w-0 break-words text-ink-tertiary">
                  {latestRun.error.message}
                </span>
              ) : null}
            </>
          ) : (
            <Pill tone={COLLECTION_STATUS_TONE[collection.status]}>
              {COLLECTION_STATUS_LABELS[collection.status]}
            </Pill>
          )}

          <span>原图 {assets.length} 张</span>
          <span>
            {LIBRARY_COPY.libraryTab} {library.total} {LIBRARY_COPY.itemCountSuffix}
          </span>
        </div>
      </div>

      <div className="grid gap-4 min-[1240px]:min-h-0 min-[1240px]:flex-1 min-[1240px]:grid-cols-[232px_minmax(0,1fr)_268px]">
        <div data-testid="column-source" className="min-w-0 min-[1240px]:min-h-0">
          <SourceAssetsPanel
            collectionId={collection.id}
            collectionName={collection.name}
            assets={assets}
            selected={selected}
            onToggle={toggleAsset}
            onToggleAll={toggleAll}
            onAdded={() => router.refresh()}
          />
        </div>

        <div data-testid="column-results" className="min-w-0 min-[1240px]:min-h-0">
          <ResultCards
            cards={cards}
            retrying={retrying}
            onRetry={(cell) => void retryCell(cell)}
            onRerun={(card) => void rerunCard(card)}
          />
        </div>

        <div data-testid="column-settings" className="min-w-0 min-[1240px]:min-h-0">
          <SettingsColumn
            collection={collection}
            requirement={requirement}
            onRequirementChange={setRequirement}
            extraPrompt={extraPrompt}
            onExtraPromptChange={setExtraPrompt}
            submitting={submitting}
            canSubmit={selected.size > 0 && !submitting}
            error={error}
            onSubmit={() => void submit()}
          />
        </div>
      </div>
    </section>
  );
}
