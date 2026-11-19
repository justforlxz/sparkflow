import { okResponse, route } from "@/lib/http";
import { requireUser } from "@/modules/auth/service";
import { testGatewayConnection } from "@/modules/gateway/service";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/** 连接测试：发真实请求，结果区分网络错误 / 鉴权失败 / 模型不被接受 / 配置错误（AC-02-6、MKACG-903）。 */
export const POST = route<Context>(async (_request, context) => {
  await requireUser();
  const { id } = await context.params;
  return okResponse(await testGatewayConnection(id));
});
