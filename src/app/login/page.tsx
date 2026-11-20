import { buttonClass, FIELD_CLASS, INPUT_CLASS, LABEL_CLASS } from "@/components/ui/styles";
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
    <main className="flex min-h-screen items-center justify-center bg-bg px-6 py-10">
      <form
        action={firstRun ? registerAction : loginAction}
        className="w-full max-w-sm space-y-5 rounded-lg border border-line bg-panel p-6 shadow-panel"
      >
        <div className="space-y-1">
          <h1 className="text-display font-semibold text-ink">拾光 · AI 内容工坊</h1>
          <p className="text-body text-ink-secondary">
            {firstRun ? "首次使用：创建第一个账号。" : "登录后继续。"}
          </p>
        </div>

        <input type="hidden" name="next" value={nextPath} />

        {firstRun ? (
          <label className={FIELD_CLASS}>
            <span className={LABEL_CLASS}>姓名</span>
            <input
              name="name"
              type="text"
              autoComplete="name"
              required
              className={INPUT_CLASS}
            />
          </label>
        ) : null}

        <label className={FIELD_CLASS}>
          <span className={LABEL_CLASS}>邮箱</span>
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            className={INPUT_CLASS}
          />
        </label>

        <label className={FIELD_CLASS}>
          <span className={LABEL_CLASS}>密码</span>
          <input
            name="password"
            type="password"
            autoComplete={firstRun ? "new-password" : "current-password"}
            required
            className={INPUT_CLASS}
          />
        </label>

        {errorMessage ? (
          <p role="alert" className="text-body text-danger">
            {errorMessage}
          </p>
        ) : null}

        <button
          type="submit"
          className={buttonClass({ variant: "primary", className: "w-full" })}
        >
          {firstRun ? "创建账号并进入" : "登录"}
        </button>
      </form>
    </main>
  );
}
