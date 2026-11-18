/**
 * 假文本适配器，给单测与本地联调用。
 *
 * 注意与 `src/modules/generation/stages/mock.ts` 区分：那个是 `GENERATION_ADAPTER=mock` 时的
 * 整阶段替身；这里的假实现只替换「调上游」这一步，提示词拼装、解析与字段校验仍然走真实逻辑。
 */
import type { TextGenerationInput, TextGenerationResult, TextGenerator } from "./types";

export const MOCK_COPY_TEXT = JSON.stringify({
  title: "按脚本生成的标题",
  body: "这是假适配器返回的正文。\n\n第二段用于验证换行原样保留。",
  tags: ["mock", "验收"],
});

export interface MockTextGenerator extends TextGenerator {
  /** 每次调用的入参，单测用它断言提示词与密钥去向。 */
  calls: TextGenerationInput[];
}

/**
 * `text` 可以是固定回包，也可以给一个按调用次序取值的数组；
 * 用例要模拟「第一次格式异常、重试成功」时用数组。
 */
export function createMockTextGenerator(text: string | string[] = MOCK_COPY_TEXT): MockTextGenerator {
  const responses = Array.isArray(text) ? [...text] : null;
  const calls: TextGenerationInput[] = [];

  return {
    calls,
    async generate(input: TextGenerationInput): Promise<TextGenerationResult> {
      calls.push(input);
      if (responses) {
        const next = responses.shift();
        if (next === undefined) throw new Error("假适配器准备的响应不够用");
        return { text: next };
      }
      return { text: text as string };
    },
  };
}
