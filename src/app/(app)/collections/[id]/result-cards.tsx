"use client";

import { EmptyState } from "@/components/ui/EmptyState";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { buttonClass, CHECKBOX_CLASS } from "@/components/ui/styles";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import { extractionItemKey } from "@/modules/extraction/item-key";
import type { ResultCardView, ResultCellRetry, ResultCellState } from "@/modules/extraction/results";

/**
 * 中栏「处理结果」（MKACG-974 范围 5、AC-UI-8、AC-UI-9）：一张原图一张卡。
 *
 * 卡头是原图缩略图、文件名、三个状态圆点、`已完成/总数` 与「重跑」；卡内并排三类产出：
 * 完成=缩略图（点开看大图）、不存在=灰底与原因、失败=红框、原因与「重试」；
 * 运行中：处理中=扫光 + 该格原图的模糊底色，等待中=同样的模糊底色但没有扫光（MKACG-999）。
 *
 * 删除素材（MKACG-1006）：完成的格子上有勾选框与「删除」两个入口 —— 单条删除走格子上的
 * 删除按钮，批量删除走勾选 + 面板标题栏的「删除选中」；两者都只删素材，不动原图。
 * 重跑叠加出来的重复产物由标题栏的「只保留最新」一次清掉。
 *
 * 结果卡只用描边与圆角，**不带阴影** —— 外层三栏面板已经有唯一的阴影档（AC-UI-4）。
 */
export interface ResultSelectionProps {
  /** 勾选中的素材 id（批量删除用）。 */
  selected: ReadonlySet<string>;
  /** 重复堆积的旧产物条数：0 时「只保留最新」不可点。 */
  staleCount: number;
  onToggle(assetId: string): void;
  onClear(): void;
  onDeleteSelected(): void;
  onDeleteOne(assetId: string): void;
  onKeepLatest(): void;
}

export interface ResultCardsProps {
  cards: ResultCardView[];
  /** 刚刚点了「重试」的格子（`<原图id>|<类别>`）：这些格子显示「重试中」而不是「提取中」。 */
  retrying: ReadonlySet<string>;
  onRetry(retry: ResultCellRetry): void;
  onRerun(card: ResultCardView): void;
  selection: ResultSelectionProps;
}

/**
 * 角标的无障碍名称：可见文字是「含水印」，原因跟在后面。
 * 没有原因（理论上不会发生：`false` 一定带原因）时只读可见文字，不补编。
 */
function watermarkLabel(note: string | null): string {
  return note ? `${LIBRARY_COPY.watermarkBadge}：${note}` : LIBRARY_COPY.watermarkBadge;
}

/** 状态圆点与格子的颜色：颜色只从设计变量的 class 取，不写字面色值（AC-D-1）。 */
const DOT_CLASS: Record<ResultCellState, string> = {
  done: "bg-positive",
  absent: "bg-line-strong",
  failed: "bg-danger",
  pending: "bg-warning",
  waiting: "bg-warning/50",
  idle: "bg-soft",
};

export function ResultCards({ cards, retrying, onRetry, onRerun, selection }: ResultCardsProps) {
  return (
    <Panel
      testId="panel-results"
      title={LIBRARY_COPY.resultsPanelTitle}
      className="min-[1240px]:flex min-[1240px]:h-full min-[1240px]:min-h-0 min-[1240px]:flex-col"
      bodyClassName="min-[1240px]:min-h-0 min-[1240px]:flex-1 min-[1240px]:overflow-y-auto"
      actions={
        cards.length === 0 ? undefined : (
          <>
            <span
              data-testid="result-selection-count"
              className="text-footnote text-ink-secondary"
            >
              {LIBRARY_COPY.selectedLibraryLabel} {selection.selected.size}{" "}
              {LIBRARY_COPY.itemCountSuffix}
            </span>
            <button
              type="button"
              data-testid="result-clear-selection"
              onClick={selection.onClear}
              disabled={selection.selected.size === 0}
              className={buttonClass({ size: "sm" })}
            >
              {LIBRARY_COPY.clearSelection}
            </button>
            <button
              type="button"
              data-testid="result-delete-selected"
              onClick={selection.onDeleteSelected}
              disabled={selection.selected.size === 0}
              className={buttonClass({ variant: "danger", size: "sm" })}
            >
              {LIBRARY_COPY.deleteSelectedAction}
            </button>
            <button
              type="button"
              data-testid="result-keep-latest"
              onClick={selection.onKeepLatest}
              disabled={selection.staleCount === 0}
              className={buttonClass({ size: "sm" })}
            >
              {LIBRARY_COPY.keepLatestAction}
            </button>
          </>
        )
      }
    >
      {cards.length === 0 ? (
        <EmptyState message={LIBRARY_COPY.emptyResults} />
      ) : (
        <ul className="space-y-2">
          {cards.map((card) => (
            <li key={card.sourceAssetId}>
              <ResultCard
                card={card}
                retrying={retrying}
                onRetry={onRetry}
                onRerun={onRerun}
                selection={selection}
              />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ResultCard({
  card,
  retrying,
  onRetry,
  onRerun,
  selection,
}: {
  card: ResultCardView;
  retrying: ReadonlySet<string>;
  onRetry(retry: ResultCellRetry): void;
  onRerun(card: ResultCardView): void;
  selection: ResultSelectionProps;
}) {
  return (
    <article
      data-testid="result-card"
      data-source-asset-id={card.sourceAssetId}
      className="min-h-[154px] rounded-lg border border-line bg-panel p-2.5"
    >
      <div className="flex items-center gap-2">
        {/* 原图缩略图 30px：卡头的锚点，告诉用户这张卡属于哪张图。 */}
        {/* eslint-disable-next-line @next/next/no-img-element -- 鉴权路由，不走 Next 图片优化器 */}
        <img
          src={card.thumbnailUrl}
          alt={card.fileName}
          className="h-[30px] w-[30px] shrink-0 rounded-sm border border-line object-cover"
        />
        <span className="min-w-0 flex-1 truncate text-body text-ink" title={card.fileName}>
          {card.fileName}
        </span>
        <span className="flex items-center gap-1" aria-hidden>
          {card.cells.map((cell) => (
            <span
              key={cell.category}
              data-testid="result-dot"
              data-state={cell.state}
              title={cell.label}
              className={`h-2 w-2 rounded-full ${DOT_CLASS[cell.state]}`}
            />
          ))}
        </span>
        <span data-testid="result-card-count" className="shrink-0 text-footnote text-ink-secondary">
          {card.done}/{card.total}
        </span>
        <button
          type="button"
          data-testid="result-card-rerun"
          onClick={() => onRerun(card)}
          className={buttonClass({ variant: "ghost", size: "sm" })}
        >
          {LIBRARY_COPY.rerunAction}
        </button>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        {card.cells.map((cell) => {
          const isRetrying = retrying.has(extractionItemKey(card.sourceAssetId, cell.category));
          return (
            <div key={cell.category} className="space-y-1">
              <p className="text-caption text-ink-tertiary">{cell.label}</p>
              {cell.state === "done" && cell.asset ? (
                <div className="relative">
                  <ImageLightbox
                    image={cell.asset}
                    openLabel={LIBRARY_COPY.viewImage}
                    closeLabel={LIBRARY_COPY.closePreview}
                    thumbnailClassName="h-[72px] w-full rounded-md border border-line object-cover transition-opacity hover:opacity-90"
                  />
                  {/* 没去掉上游水印的产物：角上标「含水印」，原因挂在 title 与 aria-label 上（MKACG-1004）。
                      角标**不遮指针事件**：`pointer-events-none` 会把命中测试让给下面的缩略图按钮，
                      它自己的 title（「查看大图」）会顶掉这里的「为什么还带水印」；`tabIndex` 让键盘
                      与读屏用户也能听到这条原因。 */}
                  {cell.asset.watermarkRemoved ? null : (
                    <Pill
                      data-testid="library-watermark-badge"
                      tone="warning"
                      title={cell.asset.watermarkNote ?? undefined}
                      tabIndex={0}
                      aria-label={watermarkLabel(cell.asset.watermarkNote)}
                      className="absolute left-1 top-1"
                    >
                      {LIBRARY_COPY.watermarkBadge}
                    </Pill>
                  )}
                  {/* 单条删除（AC-DEL2-1）：只删这一条素材，同一张原图的其它类别不受影响。 */}
                  <button
                    type="button"
                    data-testid="result-cell-delete"
                    data-category={cell.category}
                    aria-label={`${LIBRARY_COPY.deleteAssetLabel}：${cell.asset.fileName}`}
                    title={LIBRARY_COPY.deleteAssetAction}
                    onClick={() => {
                      if (cell.asset) selection.onDeleteOne(cell.asset.id);
                    }}
                    className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-sm border border-line bg-panel/90 text-caption leading-none text-ink-secondary transition-colors hover:border-danger/40 hover:bg-danger-soft hover:text-danger"
                  >
                    ×
                  </button>
                  {/* 批量删除（AC-DEL2-2）：勾选多条后走标题栏的「删除选中」。 */}
                  <label className="absolute bottom-1 left-1 flex items-center rounded-sm bg-panel/90 p-0.5">
                    <input
                      type="checkbox"
                      data-testid="result-cell-select"
                      data-category={cell.category}
                      className={CHECKBOX_CLASS}
                      checked={selection.selected.has(cell.asset.id)}
                      onChange={() => {
                        if (cell.asset) selection.onToggle(cell.asset.id);
                      }}
                      aria-label={`${LIBRARY_COPY.librarySelectLabel}：${cell.asset.fileName}`}
                    />
                  </label>
                </div>
              ) : cell.state === "failed" ? (
                <div
                  data-testid="result-cell"
                  data-state="failed"
                  data-category={cell.category}
                  className="flex h-[72px] flex-col justify-between gap-1 rounded-md border border-danger/40 bg-danger-soft p-1.5"
                >
                  <p
                    data-testid="result-cell-reason"
                    title={cell.reason ?? undefined}
                    className="line-clamp-2 text-caption text-danger"
                  >
                    {cell.reason}
                  </p>
                  <button
                    type="button"
                    data-testid="result-cell-retry"
                    onClick={() => {
                      if (cell.retry) onRetry(cell.retry);
                    }}
                    className={buttonClass({ variant: "secondary", size: "sm" })}
                  >
                    {LIBRARY_COPY.retryAction}
                  </button>
                </div>
              ) : cell.state === "absent" ? (
                <div
                  data-testid="result-cell"
                  data-state="absent"
                  data-category={cell.category}
                  className="h-[72px] space-y-1 overflow-hidden rounded-md border border-line bg-soft p-1.5"
                >
                  <p className="text-caption text-ink-secondary">{LIBRARY_COPY.absentLabel}</p>
                  <p
                    data-testid="result-cell-reason"
                    title={cell.reason ?? undefined}
                    className="line-clamp-2 text-caption text-ink-tertiary"
                  >
                    {cell.reason}
                  </p>
                </div>
              ) : cell.state === "pending" || cell.state === "waiting" ? (
                <div
                  data-testid="result-cell"
                  data-state={cell.state}
                  data-category={cell.category}
                  className={`relative flex h-[72px] items-center justify-center overflow-hidden rounded-md border border-line p-1.5 text-caption text-ink-secondary ${
                    cell.state === "pending" ? "shimmer" : ""
                  }`}
                >
                  {/* 底色用这张卡自己的原图缩略图（`?w=400`），模糊后加半透明遮罩：
                      处理中与等待中的格子各显示各自的原图，不串图（MKACG-999 AC-PROG-3）。 */}
                  {/* eslint-disable-next-line @next/next/no-img-element -- 鉴权路由，不走 Next 图片优化器 */}
                  <img
                    src={card.thumbnailUrl}
                    alt=""
                    aria-hidden
                    data-testid="result-cell-cover"
                    className="absolute inset-0 h-full w-full scale-105 object-cover blur-[2px]"
                  />
                  <span aria-hidden className="absolute inset-0 bg-panel/70" />
                  <span className="relative">
                    {isRetrying
                      ? LIBRARY_COPY.retryingLabel
                      : cell.state === "pending"
                        ? LIBRARY_COPY.processingLabel
                        : LIBRARY_COPY.waitingLabel}
                  </span>
                </div>
              ) : (
                <div
                  data-testid="result-cell"
                  data-state="idle"
                  data-category={cell.category}
                  className="flex h-[72px] items-center justify-center rounded-md border border-dashed border-line p-1.5 text-caption text-ink-tertiary"
                >
                  {LIBRARY_COPY.idleCellLabel}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </article>
  );
}
