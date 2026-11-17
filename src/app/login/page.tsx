import { safeNextPath } from "@/modules/auth/redirect";
import { hasAnyUser } from "@/modules/auth/service";
import { loginAction, registerAction } from "./actions";

// 需要读数据库判断是否已有账号，不能静态生成。
export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  login: "邮箱或密码不正确",
  register: "请检查输入：邮箱格式、姓名与密码（至少 10 个字符）",
  password: "密码至少 10 个字符，且不能与邮箱相同",
  closed: "已存在账号，请联系管理员",
  rate: "尝试次数过多，请稍后再试",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const nextPath = safeNextPath(params.next);
  const firstRun = !(await hasAnyUser());
  const errorMessage = params.error ? ERROR_MESSAGES[params.error] : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6">
      <form
        action={firstRun ? registerAction : loginAction}
        className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-200 bg-white p-6"
      >
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-zinc-900">拾光 · AI 内容工坊</h1>
          <p className="text-sm text-zinc-600">
            {firstRun ? "首次使用：创建第一个账号。" : "登录后继续。"}
          </p>
        </div>

        <input type="hidden" name="next" value={nextPath} />

        {firstRun ? (
          <label className="block space-y-1 text-sm">
            <span className="font-medium text-zinc-900">姓名</span>
            <input
              name="name"
              type="text"
              autoComplete="name"
              required
              className="w-full rounded border border-zinc-300 px-3 py-2"
            />
          </label>
        ) : null}

        <label className="block space-y-1 text-sm">
          <span className="font-medium text-zinc-900">邮箱</span>
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </label>

        <label className="block space-y-1 text-sm">
          <span className="font-medium text-zinc-900">密码</span>
          <input
            name="password"
            type="password"
            autoComplete={firstRun ? "new-password" : "current-password"}
            required
            className="w-full rounded border border-zinc-300 px-3 py-2"
          />
        </label>

        {errorMessage ? (
          <p role="alert" className="text-sm text-red-600">
            {errorMessage}
          </p>
        ) : null}

        <button
          type="submit"
          className="w-full rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white"
        >
          {firstRun ? "创建账号并进入" : "登录"}
        </button>
      </form>
    </main>
  );
}
