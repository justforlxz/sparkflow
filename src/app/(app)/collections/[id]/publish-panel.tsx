"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "@/components/api";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { LoadingState } from "@/components/ui/LoadingState";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { COPY_VERSION_STATUS_TONE } from "@/components/ui/status-tone";
import {
  buttonClass,
  CARD_LINK_CLASS,
  FIELD_CLASS,
  HINT_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  SELECT_CLASS,
  TEXTAREA_CLASS,
} from "@/components/ui/styles";
import { useToast } from "@/components/ui/Toast";
import { PublishRecordItem } from "@/components/publish/publish-record-item";
import {
  COPY_VERSION_COPY,
  COPY_VERSION_POLL_INTERVAL_MS,
} from "@/modules/copy-generation/constants";
import { COPY_STYLES } from "@/modules/copy-generation/styles";
import { activeVersions, formatVersionTime, titleFirstLine } from "@/modules/copy-generation/summary";
import type { CopyVersionView } from "@/modules/copy-generation/view";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import type { LibraryView } from "@/modules/extraction/view";
import { MAX_PAGE_SIZE } from "@/modules/media-collection/constants";
import type { CollectionDetailView } from "@/modules/media-collection/service";
import { DEFAULT_PLATFORM, PUBLISH_COPY } from "@/modules/publish/constants";
import { formatPublishText, parseTagInput } from "@/modules/publish/text";
import type { PublishRecordView } from "@/modules/publish/view";
import { LibraryGroups } from "./library-groups";

/**
 * 「发布」页签（docs/prd/12「页面结构」第三行，发布页选素材、文案版本与历史）。
 *
 * 五块按顺序排开，素材与文案不混排（AC-P-1）：
 * 1. 从素材库分组选素材（与素材库页签同一个 `LibraryGroups`，不复制一套分组）；
 * 2. 选文案风格后「生成文案」，每次生成一个新版本（MUST 5）；
 * 3. 当前版本文案：标题 / 正文 / 标签分开呈现，可原地保存、可一键复制；
 * 4. 历史版本列表：版本号、生成时间、素材数量、标题首行，点开看该版完整文案与当时选的素材；
 * 5. 发布记录：与本资源夹的发布记录同一份数据（docs/prd/08）。
 *
 * 数据来源：页面只给资源夹与素材库（页签已持有），文案版本与发布记录在这里取 ——
 * 页签切换会卸载本组件，重新挂载时必须拉一次最新状态，否则在别的页签里生成完再切回来会看到旧列表。
 * 有未终态版本时按 `COPY_VERSION_POLL_INTERVAL_MS` 轮询；全部进入终态后刷新页面计数。
 */
export interface PublishPanelProps {
  collection: CollectionDetailView;
  library: LibraryView;
}

interface CopyVersionList {
  versions: CopyVersionView[];
}

interface PublishRecordList {
  items: PublishRecordView[];
  total: number;
}

interface Draft {
  title: string;
  body: string;
  tags: string;
}

const EMPTY_DRAFT: Draft = { title: "", body: "", tags: "" };

/**
 * 取回资源夹里的全部发布记录：一页一页拉到 total 为止。
 * 放在组件外是因为挂载时的首次加载在 `useEffect` 里，那里只能通过返回结果改状态。
 */
async function fetchAllRecords(collectionId: string): Promise<PublishRecordView[]> {
  const all: PublishRecordView[] = [];
  for (let page = 1; ; page += 1) {
    const data = await fetchJson<PublishRecordList>(
      `/api/collections/${collectionId}/publish-records?page=${page}&pageSize=${MAX_PAGE_SIZE}`,
    );
    all.push(...data.items);
    if (all.length >= data.total || data.items.length === 0) break;
  }
  return all;
}

export function PublishPanel({ collection, library }: PublishPanelProps) {
  const router = useRouter();
  const toast = useToast();

  const [versions, setVersions] = useState<CopyVersionView[] | null>(null);
  const [records, setRecords] = useState<PublishRecordView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [copyStyle, setCopyStyle] = useState<string>(COPY_STYLES[0].value);
  const [extraPrompt, setExtraPrompt] = useState("");
  const [generating, setGenerating] = useState(false);

  const [openedId, setOpenedId] = useState<string | null>(null);
  // 用户改过的草稿连同它对应的服务端快照一起存：服务端内容变了（保存成功或新生成）就丢草稿。
  const [draftState, setDraftState] = useState<{ base: string; value: Draft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [marking, setMarking] = useState(false);

  const loadVersions = useCallback(async () => {
    const data = await fetchJson<CopyVersionList>(
      `/api/collections/${collection.id}/copy-versions`,
    );
    setVersions(data.versions);
    return data.versions;
  }, [collection.id]);

  const loadRecords = useCallback(async () => {
    const all = await fetchAllRecords(collection.id);
    setRecords(all);
    return all;
  }, [collection.id]);

  // 首次挂载就取一次：页签切换会卸载这里，重新进来必须是服务器上的最新版本与记录。
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchJson<CopyVersionList>(`/api/collections/${collection.id}/copy-versions`),
      fetchAllRecords(collection.id),
    ])
      .then(([versionList, recordList]) => {
        if (cancelled) return;
        setVersions(versionList.versions);
        setRecords(recordList);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(cause instanceof Error ? cause.message : COPY_VERSION_COPY.loadFailed);
      });
    return () => {
      cancelled = true;
    };
  }, [collection.id]);

  const active = activeVersions(versions ?? []);
  const polling = active.length > 0;

  // 只在生成中轮询；进入终态后清掉定时器。
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => {
      loadVersions().catch((cause: unknown) => {
        setActionError(cause instanceof Error ? cause.message : COPY_VERSION_COPY.progressFailed);
      });
    }, COPY_VERSION_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [polling, loadVersions]);

  // 从「生成中」变成「全部结束」时刷新页面顶部的版本计数；首次渲染不触发。
  const wasPolling = useRef(polling);
  useEffect(() => {
    const previous = wasPolling.current;
    wasPolling.current = polling;
    if (!previous || polling) return;
    router.refresh();
  }, [polling, router]);

  const currentVersion = versions?.[0] ?? null;
  const openedVersion =
    (openedId ? (versions ?? []).find((version) => version.id === openedId) : undefined) ??
    currentVersion;
  const isCurrent = openedVersion !== null && currentVersion !== null && openedVersion.id === currentVersion.id;

  // 草稿的基准：这几项一变（换版本、保存成功、生成完成）就回到服务端的值。
  // 轮询更新同一个版本的进度不算变，用户正在改的内容不会被冲掉。
  const draftBase = openedVersion
    ? [
        openedVersion.id,
        openedVersion.title ?? "",
        openedVersion.body ?? "",
        openedVersion.tags.join(","),
      ].join("|")
    : "";
  const serverDraft: Draft = openedVersion
    ? {
        title: openedVersion.title ?? "",
        body: openedVersion.body ?? "",
        tags: openedVersion.tags.join(", "),
      }
    : EMPTY_DRAFT;
  const draft = draftState?.base === draftBase ? draftState.value : serverDraft;

  function updateDraft(next: Draft): void {
    setDraftState({ base: draftBase, value: next });
  }

  const recordsByVersion = useMemo(() => {
    const map = new Map<string, PublishRecordView>();
    for (const record of records ?? []) map.set(record.copyVersionId, record);
    return map;
  }, [records]);

  const history = (versions ?? []).filter((version) => version.id !== currentVersion?.id);
  const editable = isCurrent && openedVersion?.status === "succeeded";
  const publishedRecord = openedVersion ? (recordsByVersion.get(openedVersion.id) ?? null) : null;

  function toggleAsset(assetId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  async function generate(): Promise<void> {
    if (selected.size === 0) return;
    setGenerating(true);
    setActionError(null);
    try {
      const data = await fetchJson<{ version: CopyVersionView }>(
        `/api/collections/${collection.id}/copy-versions`,
        {
          method: "POST",
          body: JSON.stringify({
            selectedAssetIds: [...selected],
            copyStyle,
            extraPrompt: extraPrompt.trim() === "" ? undefined : extraPrompt.trim(),
          }),
        },
      );
      setVersions((current) => [data.version, ...(current ?? [])]);
      setOpenedId(null);
      // 这一批素材已经交给文案 Agent：清空选择，下一次生成从新的一批开始。
      setSelected(new Set());
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : COPY_VERSION_COPY.generateFailed);
    } finally {
      setGenerating(false);
    }
  }

  async function save(): Promise<void> {
    if (!openedVersion) return;
    setSaving(true);
    setActionError(null);
    try {
      const data = await fetchJson<{ version: CopyVersionView }>(
        `/api/copy-versions/${openedVersion.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            title: draft.title.trim(),
            body: draft.body.trim(),
            tags: parseTagInput(draft.tags),
          }),
        },
      );
      setVersions((current) =>
        (current ?? []).map((version) => (version.id === data.version.id ? data.version : version)),
      );
      toast.show(COPY_VERSION_COPY.savedNotice, "success");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : COPY_VERSION_COPY.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  async function copyText(): Promise<void> {
    // 复制的是界面上当前看到的三段，格式与发布准备一致（docs/prd/08 MUST 4、AC-P-2）。
    const text = formatPublishText({
      title: draft.title,
      body: draft.body,
      tags: parseTagInput(draft.tags),
    });
    try {
      await navigator.clipboard.writeText(text);
      toast.show(PUBLISH_COPY.copiedNotice, "success");
    } catch {
      toast.show(PUBLISH_COPY.copyFailed, "danger");
    }
  }

  async function markPublished(): Promise<void> {
    if (!openedVersion) return;
    setMarking(true);
    setActionError(null);
    try {
      await fetchJson<{ record: PublishRecordView }>(
        `/api/copy-versions/${openedVersion.id}/publish`,
        { method: "POST", body: JSON.stringify({ platform: DEFAULT_PLATFORM }) },
      );
      // 幂等：同一版本重复标记只更新那条记录（AC-LIB-8），界面重新拉一次即可。
      await loadRecords();
      toast.show(PUBLISH_COPY.markedNotice, "success");
      router.refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : PUBLISH_COPY.markFailed);
    } finally {
      setMarking(false);
    }
  }

  return (
    <div className="space-y-6">
      {loadError ? <ErrorState message={loadError} /> : null}
      {actionError ? <ErrorState message={actionError} /> : null}

      <SelectionSection
        collection={collection}
        library={library}
        selected={selected}
        onToggle={toggleAsset}
        onClear={() => setSelected(new Set())}
      />

      <GenerateSection
        copyStyle={copyStyle}
        extraPrompt={extraPrompt}
        selectedCount={selected.size}
        generating={generating}
        active={active}
        onCopyStyleChange={setCopyStyle}
        onExtraPromptChange={setExtraPrompt}
        onGenerate={() => void generate()}
      />

      {versions === null ? (
        <LoadingState label={COPY_VERSION_COPY.listTitle} />
      ) : versions.length === 0 ? (
        <EmptyState message={COPY_VERSION_COPY.emptyList} />
      ) : (
        <>
          <OpenedVersionPanel
            version={openedVersion}
            isCurrent={isCurrent}
            draft={draft}
            editable={editable}
            saving={saving}
            marking={marking}
            publishedRecord={publishedRecord}
            onDraftChange={updateDraft}
            onSave={() => void save()}
            onCopy={() => void copyText()}
            onMarkPublished={() => void markPublished()}
            onBackToCurrent={() => setOpenedId(null)}
          />

          <HistorySection
            versions={history}
            recordsByVersion={recordsByVersion}
            onOpen={setOpenedId}
          />
        </>
      )}

      <RecordsSection records={records} />
    </div>
  );
}

interface SelectionSectionProps {
  collection: CollectionDetailView;
  library: LibraryView;
  selected: ReadonlySet<string>;
  onToggle(assetId: string): void;
  onClear(): void;
}

/** 第 1 块：从素材库分组选素材。只有选择，没有文案（AC-P-1）。 */
function SelectionSection({
  collection,
  library,
  selected,
  onToggle,
  onClear,
}: SelectionSectionProps) {
  return (
    <Panel
      title={COPY_VERSION_COPY.selectSectionTitle}
      description={COPY_VERSION_COPY.selectSectionHint}
    >
      <div data-testid="panel-publish-library" className="space-y-4">
        {library.total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p data-testid="publish-selected-count" className="text-body text-ink-secondary">
              {LIBRARY_COPY.selectedLibraryLabel} {selected.size} {LIBRARY_COPY.itemCountSuffix}
            </p>
            <button
              type="button"
              onClick={onClear}
              disabled={selected.size === 0}
              className={buttonClass({ size: "sm" })}
            >
              {LIBRARY_COPY.clearSelection}
            </button>
          </div>
        ) : null}
        <LibraryGroups
          library={library}
          sourceAssets={collection.assets}
          selected={selected}
          onToggle={onToggle}
          selectLabel={LIBRARY_COPY.librarySelectLabel}
          emptyMessage={COPY_VERSION_COPY.selectEmpty}
        />
      </div>
    </Panel>
  );
}

interface GenerateSectionProps {
  copyStyle: string;
  extraPrompt: string;
  selectedCount: number;
  generating: boolean;
  active: CopyVersionView[];
  onCopyStyleChange(value: string): void;
  onExtraPromptChange(value: string): void;
  onGenerate(): void;
}

/** 第 2 块：文案风格、补充要求与「生成文案」；生成中显示进度（未选素材时按钮置灰，AC-P-3）。 */
function GenerateSection({
  copyStyle,
  extraPrompt,
  selectedCount,
  generating,
  active,
  onCopyStyleChange,
  onExtraPromptChange,
  onGenerate,
}: GenerateSectionProps) {
  const canGenerate = selectedCount > 0 && !generating;

  return (
    <Panel title={COPY_VERSION_COPY.generateSectionTitle}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={FIELD_CLASS}>
            <span className={LABEL_CLASS}>{COPY_VERSION_COPY.styleLabel}</span>
            <select
              data-testid="publish-style"
              className={SELECT_CLASS}
              value={copyStyle}
              onChange={(event) => onCopyStyleChange(event.target.value)}
            >
              {COPY_STYLES.map((style) => (
                <option key={style.value} value={style.value}>
                  {style.label}
                </option>
              ))}
            </select>
          </label>
          <label className={FIELD_CLASS}>
            <span className={LABEL_CLASS}>{COPY_VERSION_COPY.extraPromptLabel}</span>
            <textarea
              data-testid="publish-extra-prompt"
              className={`${TEXTAREA_CLASS} min-h-16`}
              rows={2}
              value={extraPrompt}
              placeholder={COPY_VERSION_COPY.extraPromptPlaceholder}
              onChange={(event) => onExtraPromptChange(event.target.value)}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="publish-generate"
            disabled={!canGenerate}
            onClick={onGenerate}
            className={buttonClass({ variant: "primary" })}
          >
            {generating ? COPY_VERSION_COPY.generatingLabel : COPY_VERSION_COPY.generateAction}
          </button>
          {selectedCount === 0 ? (
            <p data-testid="publish-generate-hint" className={HINT_CLASS}>
              {COPY_VERSION_COPY.generateNeedsSelection}
            </p>
          ) : null}
        </div>

        {active.length > 0 ? (
          <div className="space-y-1 rounded-md border border-line bg-panel px-3 py-2">
            {active.map((version) => (
              <p
                key={version.id}
                data-testid="publish-progress"
                className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-ink"
              >
                <Pill tone={COPY_VERSION_STATUS_TONE[version.status]}>{version.statusLabel}</Pill>
                <span>{COPY_VERSION_COPY.generatingVersion(version.versionLabel)}</span>
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

interface OpenedVersionPanelProps {
  version: CopyVersionView | null;
  isCurrent: boolean;
  draft: Draft;
  editable: boolean;
  saving: boolean;
  marking: boolean;
  publishedRecord: PublishRecordView | null;
  onDraftChange(next: Draft): void;
  onSave(): void;
  onCopy(): void;
  onMarkPublished(): void;
  onBackToCurrent(): void;
}

/**
 * 第 3 块：打开的版本（默认当前版本）。标题上写明是「当前版本」还是「历史版本」，
 * 打开历史版本时给出「回到当前版本」的入口。
 */
function OpenedVersionPanel({
  version,
  isCurrent,
  draft,
  editable,
  saving,
  marking,
  publishedRecord,
  onDraftChange,
  onSave,
  onCopy,
  onMarkPublished,
  onBackToCurrent,
}: OpenedVersionPanelProps) {
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          {isCurrent ? COPY_VERSION_COPY.currentTitle : COPY_VERSION_COPY.historyDetailTitle}
          <span data-testid="publish-version-label" className="text-ink-secondary">
            {version?.versionLabel}
          </span>
          <Pill tone="neutral">
            {isCurrent ? COPY_VERSION_COPY.currentBadge : COPY_VERSION_COPY.historyBadge}
          </Pill>
        </span>
      }
      actions={
        isCurrent || !version ? null : (
          <button
            type="button"
            data-testid="publish-back-to-current"
            onClick={onBackToCurrent}
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            {COPY_VERSION_COPY.backToCurrentAction}
          </button>
        )
      }
    >
      {version ? (
        <VersionDetail
          version={version}
          draft={draft}
          editable={editable}
          saving={saving}
          marking={marking}
          publishedRecord={publishedRecord}
          onDraftChange={onDraftChange}
          onSave={onSave}
          onCopy={onCopy}
          onMarkPublished={onMarkPublished}
        />
      ) : null}
    </Panel>
  );
}

interface HistorySectionProps {
  versions: CopyVersionView[];
  recordsByVersion: ReadonlyMap<string, PublishRecordView>;
  onOpen(versionId: string): void;
}

/** 第 4 块：历史版本列表（版本号、生成时间、素材数量、标题首行）。 */
function HistorySection({ versions, recordsByVersion, onOpen }: HistorySectionProps) {
  return (
    <Panel title={COPY_VERSION_COPY.historyTitle}>
      {versions.length === 0 ? (
        <EmptyState message={COPY_VERSION_COPY.emptyHistory} />
      ) : (
        <ul className="space-y-2">
          {versions.map((version) => {
            const record = recordsByVersion.get(version.id);
            return (
              <li key={version.id}>
                <button
                  type="button"
                  data-testid="version-item"
                  data-version-no={version.versionNo}
                  onClick={() => onOpen(version.id)}
                  className={`${CARD_LINK_CLASS} w-full text-left`}
                >
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-body font-medium text-ink">{version.versionLabel}</span>
                      <Pill tone={COPY_VERSION_STATUS_TONE[version.status]}>
                        {version.statusLabel}
                      </Pill>
                      {record ? <Pill tone="published">{PUBLISH_COPY.statusPublished}</Pill> : null}
                    </span>
                    <span className="block text-footnote text-ink-tertiary">
                      {formatVersionTime(version.createdAt)} ·{" "}
                      {COPY_VERSION_COPY.versionAssetCount(version.assets.length)}
                    </span>
                    <span className="block truncate text-body text-ink">
                      {titleFirstLine(version.title) || COPY_VERSION_COPY.untitledVersion}
                    </span>
                  </span>
                  <span className="text-footnote text-ink-secondary">
                    {COPY_VERSION_COPY.openVersionAction}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

interface RecordsSectionProps {
  records: PublishRecordView[] | null;
}

/** 第 5 块：这个资源夹的发布记录，与全局 /published 页同源同组件。 */
function RecordsSection({ records }: RecordsSectionProps) {
  return (
    <Panel title={COPY_VERSION_COPY.recordsTitle}>
      {records === null ? (
        <LoadingState label={COPY_VERSION_COPY.recordsTitle} />
      ) : records.length === 0 ? (
        <EmptyState message={COPY_VERSION_COPY.recordsEmpty} />
      ) : (
        <ul className="space-y-3">
          {records.map((record) => (
            <li key={record.id}>
              <PublishRecordItem record={record} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

interface VersionDetailProps {
  version: CopyVersionView;
  draft: Draft;
  editable: boolean;
  saving: boolean;
  marking: boolean;
  publishedRecord: PublishRecordView | null;
  onDraftChange(next: Draft): void;
  onSave(): void;
  onCopy(): void;
  onMarkPublished(): void;
}

/**
 * 一个版本的完整文案 + 当时选的素材（docs/prd/12 SHOULD：点开可看完整内容）。
 * 文案三段在 `panel-publish-copy` 里，素材快照单独一块 —— 两者不混排（AC-P-1）。
 */
function VersionDetail({
  version,
  draft,
  editable,
  saving,
  marking,
  publishedRecord,
  onDraftChange,
  onSave,
  onCopy,
  onMarkPublished,
}: VersionDetailProps) {
  const canSave = draft.title.trim() !== "" && draft.body.trim() !== "" && !saving;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={COPY_VERSION_STATUS_TONE[version.status]}>{version.statusLabel}</Pill>
        {publishedRecord ? <Pill tone="published">{PUBLISH_COPY.statusPublished}</Pill> : null}
        {version.copyVisualDegraded && version.copyVisualDegradedHint ? (
          <span className="text-footnote text-warning">{version.copyVisualDegradedHint}</span>
        ) : null}
      </div>

      <div data-testid="panel-publish-copy" className="space-y-4">
        {version.status === "succeeded" ? (
          <>
            <label className={FIELD_CLASS}>
              <span className={LABEL_CLASS}>{COPY_VERSION_COPY.titleLabel}</span>
              <input
                data-testid="publish-title"
                className={INPUT_CLASS}
                value={draft.title}
                readOnly={!editable}
                onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
              />
            </label>
            <label className={FIELD_CLASS}>
              <span className={LABEL_CLASS}>{COPY_VERSION_COPY.bodyLabel}</span>
              <textarea
                data-testid="publish-body"
                className={`${TEXTAREA_CLASS} min-h-40`}
                rows={8}
                value={draft.body}
                readOnly={!editable}
                onChange={(event) => onDraftChange({ ...draft, body: event.target.value })}
              />
            </label>
            <label className={FIELD_CLASS}>
              <span className={LABEL_CLASS}>{COPY_VERSION_COPY.tagsLabel}</span>
              <input
                data-testid="publish-tags"
                className={INPUT_CLASS}
                value={draft.tags}
                readOnly={!editable}
                onChange={(event) => onDraftChange({ ...draft, tags: event.target.value })}
              />
              <span className={HINT_CLASS}>{COPY_VERSION_COPY.tagsHint}</span>
            </label>

            <div className="flex flex-wrap items-center gap-2">
              {editable ? (
                <button
                  type="button"
                  data-testid="publish-save"
                  disabled={!canSave}
                  onClick={onSave}
                  className={buttonClass({ variant: "secondary", size: "sm" })}
                >
                  {saving ? COPY_VERSION_COPY.savingLabel : COPY_VERSION_COPY.saveAction}
                </button>
              ) : null}
              <button
                type="button"
                data-testid="publish-copy"
                onClick={onCopy}
                className={buttonClass({ variant: "secondary", size: "sm" })}
              >
                {PUBLISH_COPY.copyAction}
              </button>
              {editable ? (
                <button
                  type="button"
                  data-testid="publish-mark"
                  disabled={marking}
                  onClick={onMarkPublished}
                  className={buttonClass({ variant: "primary", size: "sm" })}
                >
                  {PUBLISH_COPY.markPublishedAction}
                </button>
              ) : null}
            </div>

            {!editable ? (
              <p className={HINT_CLASS}>{COPY_VERSION_COPY.editOnlyCurrentHint}</p>
            ) : null}
          </>
        ) : version.status === "failed" ? (
          <div className="space-y-1">
            <p data-testid="publish-version-error" className="text-body text-danger">
              {version.error?.message ?? COPY_VERSION_COPY.generateFailed}
            </p>
            <p className={HINT_CLASS}>{COPY_VERSION_COPY.copyFailedHint}</p>
          </div>
        ) : (
          <p data-testid="publish-version-progress" className="text-body text-ink-secondary">
            {COPY_VERSION_COPY.generatingVersion(version.versionLabel)}
          </p>
        )}
      </div>

      <div data-testid="copy-version-assets" className="space-y-2">
        <h3 className="text-footnote font-medium text-ink-secondary">
          {COPY_VERSION_COPY.snapshotTitle}
          <span className="ml-2 font-normal text-ink-tertiary">
            {COPY_VERSION_COPY.versionAssetCount(version.assets.length)}
          </span>
        </h3>
        {version.assets.length === 0 ? (
          <p className={HINT_CLASS}>{COPY_VERSION_COPY.noSnapshotAssets}</p>
        ) : (
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {version.assets.map((asset) => (
              <li key={asset.id} className="space-y-1 text-caption text-ink-tertiary">
                {asset.deleted ? (
                  <span
                    data-testid="deleted-asset"
                    className="flex h-20 items-center justify-center rounded-md border border-dashed border-line-strong bg-soft px-1 text-center"
                  >
                    {COPY_VERSION_COPY.deletedAssetLabel}
                  </span>
                ) : (
                  <ImageLightbox
                    image={{
                      fileName: asset.fileName ?? "",
                      url: asset.url ?? "",
                      thumbnailUrl: asset.thumbnailUrl ?? "",
                    }}
                    openLabel={LIBRARY_COPY.viewImage}
                    closeLabel={LIBRARY_COPY.closePreview}
                    thumbnailClassName="h-20 w-full rounded-md border border-line object-cover transition-opacity hover:opacity-90"
                  />
                )}
                <span className="block truncate">{asset.categoryLabel}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}