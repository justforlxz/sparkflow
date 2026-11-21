/**
 * 输入长度的护栏常量（只是防超长输入，不是产品规则）。
 *
 * 文案三段、标签、勾选素材数这几项被「文案版本」「发布记录」与界面共用，
 * 集中在这里一份，避免各模块各造一套口径（AGENTS.md 硬性规则 1）。
 */

/** 提取要求 / 文案风格这类短 key 的长度上限。 */
export const MAX_STYLE_KEY_LENGTH = 40;

/** 文案标题、正文、单个标签的长度上限。 */
export const MAX_TITLE_LENGTH = 200;
export const MAX_BODY_LENGTH = 5000;
export const MAX_TAG_LENGTH = 30;

/** 一次最多勾选多少张素材：护栏，不是产品上限。 */
export const MAX_SELECTED_ASSET_IDS = 50;

/** 补充要求的长度上限（提取与文案同一口径）：只防超长输入，不是产品规则。 */
export const MAX_EXTRA_PROMPT_LENGTH = 1000;
