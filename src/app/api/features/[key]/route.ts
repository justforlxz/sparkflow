import { okResponse, readJson, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { patchFeatureFlagSchema } from "@/modules/feature-flags/schema";
import { setFeatureEnabled } from "@/modules/feature-flags/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ key: string }>;
}

export const PATCH = route<Context>(async (request, context) => {
  await requireUser();

  const { key } = await context.params;
  const input = patchFeatureFlagSchema.parse(await readJson(request));

  return okResponse({ feature: await setFeatureEnabled(key, input.enabled) });
});
