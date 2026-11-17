import { okResponse, readJson, route } from "@/lib/http";
import { getEnv } from "@/lib/env";
import { clientIp } from "@/modules/auth/request-ip";
import { loginSchema } from "@/modules/auth/schema";
import { login, persistSession } from "@/modules/auth/service";

export const dynamic = "force-dynamic";

export const POST = route(async (request) => {
  const input = loginSchema.parse(await readJson(request));
  const grant = await login(
    { ...input, ip: clientIp(request.headers, getEnv().TRUST_PROXY === "true") },
    { userAgent: request.headers.get("user-agent") },
  );

  await persistSession(grant);
  return okResponse({ user: grant.user });
});
