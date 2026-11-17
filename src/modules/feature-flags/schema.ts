import { z } from "zod";

/** `PATCH /api/features/[key]` 的请求体。 */
export const patchFeatureFlagSchema = z.object({
  enabled: z.boolean(),
});

export type PatchFeatureFlagInput = z.infer<typeof patchFeatureFlagSchema>;
