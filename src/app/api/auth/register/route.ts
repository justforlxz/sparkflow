import { okResponse, readJson, route } from "@/lib/http";
import { registerSchema } from "@/modules/auth/schema";
import { persistSession, registerFirstUser } from "@/modules/auth/service";

export const dynamic = "force-dynamic";

/** 只有用户表为空时才允许注册（AC-11-2）。 */
export const POST = route(async (request) => {
  const input = registerSchema.parse(await readJson(request));
  const grant = await registerFirstUser(input, {
    userAgent: request.headers.get("user-agent"),
  });

  await persistSession(grant);
  return okResponse({ user: grant.user }, 201);
});
