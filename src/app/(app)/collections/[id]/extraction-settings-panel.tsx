"use client";

import { ErrorState } from "@/components/ui/ErrorState";
import { Panel } from "@/components/ui/Panel";
import { buttonClass, CHECKBOX_CLASS, LABEL_CLASS, TEXTAREA_CLASS } from "@/components/ui/styles";
import { SELECTABLE_CATEGORIES } from "@/modules/extraction/categories";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import { EXTRACT_REQUIREMENTS } from "@/modules/image-generation/styles";
import { COLLECTION_COPY } from "@/modules/media-collection/constants";
import type { CollectionDetailView } from "@/modules/media-collection/service";

/**
 * 右栏「提取设置」与它下面的「来源信息」（MKACG-974 范围 4）。
 *
 * 类别是**固定三类**（桌面俯视图 / 基本纹理 / 形象设计），界面只做说明、不给勾选框：
 * 每张原图都要走完三类判定，结果卡才是「三类产出并排」（AC-UI-8）。
 *
 * 「条件」沿用数据层的单值 `requirement`（ADR 0009、prd/05 三项互斥），
 * 因此这里是单选：一项「忠实还原」与一项「去反光」给模型的指令本身互相冲突
 * （一个要求保留瑕疵、一个要求去掉高光），选多项没有明确语义。
 */
export interface SettingsColumnProps {
  collection: CollectionDetailView;
  requirement: string;
  onRequirementChange(value: string): void;
  extraPrompt: string;
  onExtraPromptChange(value: string): void;
  submitting: boolean;
  canSubmit: boolean;
  error: string | null;
  onSubmit(): void;
}

export function SettingsColumn({
  collection,
  requirement,
  onRequirementChange,
  extraPrompt,
  onExtraPromptChange,
  submitting,
  canSubmit,
  error,
  onSubmit,
}: SettingsColumnProps) {
  return (
    <div className="flex flex-col gap-4 min-[1240px]:h-full min-[1240px]:min-h-0">
      <Panel
        testId="panel-settings"
        title={LIBRARY_COPY.settingsPanelTitle}
        className="min-[1240px]:flex min-[1240px]:min-h-0 min-[1240px]:flex-1 min-[1240px]:flex-col"
        bodyClassName="min-[1240px]:min-h-0 min-[1240px]:flex-1 min-[1240px]:overflow-y-auto"
        actions={
          <button
            type="button"
            data-testid="extract-submit"
            onClick={onSubmit}
            disabled={!canSubmit}
            className={buttonClass({ variant: "primary", size: "sm" })}
          >
            {submitting ? LIBRARY_COPY.submittingLabel : LIBRARY_COPY.oneClickExtract}
          </button>
        }
      >
        <div className="space-y-4">
          {error ? <ErrorState message={error} /> : null}

          <fieldset className="space-y-2">
            <legend className={LABEL_CLASS}>{LIBRARY_COPY.conditionLabel}</legend>
            {EXTRACT_REQUIREMENTS.map((entry) => (
              <label key={entry.value} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="extraction-requirement"
                  className={`${CHECKBOX_CLASS} mt-0.5`}
                  value={entry.value}
                  checked={requirement === entry.value}
                  onChange={() => onRequirementChange(entry.value)}
                />
                <span className="min-w-0">
                  <span className="block text-body text-ink">{entry.label}</span>
                  <span className="block text-caption text-ink-tertiary">{entry.description}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <label className="block space-y-1.5">
            <span className={LABEL_CLASS}>{LIBRARY_COPY.extraPromptLabel}</span>
            <textarea
              data-testid="extra-prompt"
              rows={2}
              value={extraPrompt}
              placeholder={LIBRARY_COPY.extraPromptPlaceholder}
              onChange={(event) => onExtraPromptChange(event.target.value)}
              className={TEXTAREA_CLASS}
            />
          </label>

          <div className="space-y-1.5">
            <p className={LABEL_CLASS}>{LIBRARY_COPY.fixedCategoriesLabel}</p>
            <ul className="space-y-1">
              {SELECTABLE_CATEGORIES.map((category) => (
                <li key={category.value} className="text-caption text-ink-tertiary">
                  <span className="block text-body text-ink-secondary">{category.label}</span>
                  {category.description}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Panel>

      <Panel testId="panel-source-info" title={COLLECTION_COPY.sourceSection} className="shrink-0">
        <dl className="text-body">
          <SourceRow label="来源平台" value={collection.platform} />
          <SourceRow label="来源链接" value={collection.sourceUrl} />
          <SourceRow label="原始标题" value={collection.sourceTitle} />
          <SourceRow label="原始文案" value={collection.sourceBody} />
        </dl>
      </Panel>
    </div>
  );
}

function SourceRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-3 border-b border-line py-2 last:border-b-0">
      <dt className="w-20 shrink-0 text-ink-tertiary">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-ink">
        {value ?? COLLECTION_COPY.notFoundSource}
      </dd>
    </div>
  );
}
