"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { fetchJson } from "@/components/api";
import { ErrorState } from "@/components/ui/ErrorState";
import { LIBRARY_COPY, EXTRACTION_POLL_INTERVAL_MS } from "@/modules/extraction/constants";
import { splitRuns } from "@/modules/extraction/summary";
import type { ExtractionRunView, LibraryView } from "@/modules/extraction/view";
import type { CollectionDetailView } from "@/modules/media-collection/service";
import { LibraryPanel } from "./library-panel";
import { OriginalAssetsPanel } from "./original-assets-panel";

/**
 * 资源夹详情的页签（docs/prd/12-asset-library.md「页面结构」）：
 * 本节点落地「原始素材」与「素材库」两个页签，「发布」页签由 MKACG-940 落地。
 *
 * 这个组件是页签里唯一的取数方：持有提取运行与素材库两份状态，
 * 有未终态运行时按 `EXTRACTION_POLL_INTERVAL_MS` 轮询运行列表；运行全部进入终态后
 * 再拉一次素材库（新素材那一刻才入库），并 `router.refresh()` 让页面顶部的计数一起更新。
 * 两个页签只接收数据与回调，不各自发请求（AGENTS.md 硬性规则 10：查询不散在组件里）。
 */
type TabValue = "assets" | "library";

const TABS: ReadonlyArray<{ value: TabValue; label: string }> = [
  { value: "assets", label: LIBRARY_COPY.assetsTab },
  { value: "library", label: LIBRARY_COPY.libraryTab },
];

export interface CollectionTabsProps {
  collection: CollectionDetailView;
  initialRuns: ExtractionRunView[];
  initialLibrary: LibraryView;
}

export function CollectionTabs({ collection, initialRuns, initialLibrary }: CollectionTabsProps) {
  const router = useRouter();
  const [tab, setTab] = useState<TabValue>("assets");
  const [runs, setRuns] = useState<ExtractionRunView[]>(initialRuns);
  const [library, setLibrary] = useState<LibraryView>(initialLibrary);
  const [pollError, setPollError] = useState<string | null>(null);

  const { active, finished } = splitRuns(runs);
  const polling = active.length > 0;

  const reloadRuns = useCallback(async () => {
    const data = await fetchJson<{ runs: ExtractionRunView[] }>(
      `/api/collections/${collection.id}/extractions`,
    );
    setRuns(data.runs);
  }, [collection.id]);

  const reloadLibrary = useCallback(async () => {
    setLibrary(
      await fetchJson<LibraryView>(`/api/collections/${collection.id}/library`),
    );
  }, [collection.id]);

  // 只在有未终态运行时轮询，进入终态后清理定时器（docs/prd/07 MUST 4）。
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      reloadRuns()
        .then(() => {
          if (!cancelled) setPollError(null);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setPollError(cause instanceof Error ? cause.message : "提取进度更新失败");
        });
    }, EXTRACTION_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [polling, reloadRuns]);

  // 从「有进行中」变成「全部终态」时刷新素材库与顶部计数；首次渲染不触发。
  const hadActiveRun = useRef(polling);
  useEffect(() => {
    const wasPolling = hadActiveRun.current;
    hadActiveRun.current = polling;
    if (!wasPolling || polling) return;

    let cancelled = false;
    reloadLibrary()
      .then(() => {
        if (!cancelled) router.refresh();
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setPollError(cause instanceof Error ? cause.message : "素材库刷新失败");
      });

    return () => {
      cancelled = true;
    };
  }, [polling, reloadLibrary, router]);

  const handleRunCreated = useCallback((run: ExtractionRunView) => {
    setRuns((current) => [run, ...current]);
  }, []);

  const handleLibraryChanged = useCallback(async () => {
    await reloadLibrary();
    router.refresh();
  }, [reloadLibrary, router]);

  const tabRefs = useRef<Record<TabValue, HTMLButtonElement | null>>({
    assets: null,
    library: null,
  });

  /** ARIA 页签模式：左右方向键在页签间移动并选中（Tab 键只进当前页签）。 */
  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, value: TabValue): void {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = TABS.findIndex((entry) => entry.value === value);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = TABS[(index + step + TABS.length) % TABS.length];
    if (!next) return;
    setTab(next.value);
    tabRefs.current[next.value]?.focus();
  }

  function tabClassName(value: TabValue): string {
    const base = "-mb-px border-b-2 px-3 py-2 text-body transition-colors";
    return tab === value
      ? `${base} border-accent font-semibold text-ink`
      : `${base} border-transparent text-ink-secondary hover:text-ink`;
  }

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="资源夹页签" className="flex border-b border-line">
        {TABS.map((entry) => (
          <button
            key={entry.value}
            ref={(element) => {
              tabRefs.current[entry.value] = element;
            }}
            type="button"
            role="tab"
            id={`tab-${entry.value}`}
            aria-selected={tab === entry.value}
            aria-controls={`panel-${entry.value}`}
            data-testid={`tab-${entry.value}`}
            tabIndex={tab === entry.value ? 0 : -1}
            onClick={() => setTab(entry.value)}
            onKeyDown={(event) => handleTabKeyDown(event, entry.value)}
            className={tabClassName(entry.value)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {pollError ? <ErrorState message={pollError} /> : null}

      {tab === "assets" ? (
        <div
          role="tabpanel"
          id="panel-assets"
          aria-labelledby="tab-assets"
          data-testid="panel-assets"
        >
          <OriginalAssetsPanel
            collection={collection}
            activeRuns={active}
            finishedRuns={finished}
            onRunCreated={handleRunCreated}
          />
        </div>
      ) : (
        <div
          role="tabpanel"
          id="panel-library"
          aria-labelledby="tab-library"
          data-testid="panel-library"
        >
          <LibraryPanel
            collection={collection}
            library={library}
            onLibraryChanged={handleLibraryChanged}
          />
        </div>
      )}
    </div>
  );
}
