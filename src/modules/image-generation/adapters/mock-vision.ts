/**
 * mock 视觉判定（`GENERATION_ADAPTER=mock`，docs/acceptance.md 第 3 节）：
 * 不调上游，按补充要求里的脚本标记回答「存在 / 不存在」，供 CI 跑通两段式判定。
 *
 * 脚本标记见 `mock-script.ts`：`mock:vision-absent-all` 让每次判定都不存在，
 * `mock:vision-absent-at-<n>` 只让第 n 次判定不存在。
 */
import type { VisionAnalyzer } from "@/modules/gateway/vision";
import { LIBRARY_COPY } from "@/modules/extraction/constants";
import { MATERIAL_PROMPT_MARK } from "../material";
import { MOCK_SCRIPT_HINTS, hasMockHint, mockVisionAbsentAt } from "../mock-script";

/** 判定为不存在时回给调用方的原话：会被存进 `extraction_item.skip_reason` 并显示在界面。 */
const ABSENT_REASON = `${LIBRARY_COPY.verdictAbsent}：画面里没有这个目标`;
/** 判定为存在时的原话：只用于日志，不写库。 */
const PRESENT_REASON = `${LIBRARY_COPY.verdictPresent}：目标位于画面中央`;
/** 材质描述的回复：固定一句话，供 e2e 断言提示词里带 `Material:` 段。 */
const MATERIAL_DESCRIPTION = "深灰色织物，表面有细密斜纹";

export class MockVisionAnalyzer implements VisionAnalyzer {
  private readonly absentAll: boolean;
  private readonly absentAt: number | null;
  /** 本次运行里第几次判定；一条运行一个实例，因此计数与「第几项」一致。 */
  private calls = 0;

  constructor(extraPrompt: string | null) {
    this.absentAll = hasMockHint(extraPrompt, MOCK_SCRIPT_HINTS.visionAbsentAll);
    this.absentAt = mockVisionAbsentAt(extraPrompt);
  }

  async analyzeImage(input: { prompt: string }): Promise<string> {
    // 材质描述不判断「存在 / 不存在」，也不占判定序号：否则 `mock:vision-absent-at-<n>`
    // 会随「每一项多一次调用」错位（MKACG-1000）。
    if (input.prompt.includes(MATERIAL_PROMPT_MARK)) return MATERIAL_DESCRIPTION;

    this.calls += 1;
    if (this.absentAll || this.absentAt === this.calls) return ABSENT_REASON;
    return PRESENT_REASON;
  }
}
