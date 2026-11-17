import { describe, expect, it } from "vitest";
import { loginSchema, registerSchema } from "./schema";

describe("账号输入 schema", () => {
  it("邮箱在解析时去空格并转小写（页面与接口共用同一处归一化）", () => {
    const parsed = loginSchema.parse({ email: "  Owner@Example.COM ", password: "whatever-password" });

    expect(parsed.email).toBe("owner@example.com");
  });

  it("注册同样归一化邮箱，并去掉姓名两端空格", () => {
    const parsed = registerSchema.parse({
      email: "Owner@Example.COM",
      name: "  站长  ",
      password: "long enough password",
    });

    expect(parsed).toMatchObject({ email: "owner@example.com", name: "站长" });
  });

  it("非法邮箱被拒", () => {
    expect(() =>
      loginSchema.parse({ email: "not-an-email", password: "whatever-password" }),
    ).toThrowError(/邮箱/);
  });

  it("注册拒绝过短密码与过长姓名", () => {
    const base = { email: "owner@example.com", name: "站长", password: "long enough password" };

    expect(() => registerSchema.parse({ ...base, password: "short" })).toThrowError(/密码/);
    expect(() => registerSchema.parse({ ...base, name: "长".repeat(61) })).toThrowError(/姓名/);
    expect(() => registerSchema.parse({ ...base, name: "   " })).toThrowError(/姓名/);
  });

  it("登录只要求密码非空（长度由密码策略在注册/重置时判定）", () => {
    expect(() =>
      loginSchema.parse({ email: "owner@example.com", password: "" }),
    ).toThrowError(/密码/);
    expect(loginSchema.parse({ email: "owner@example.com", password: "x" }).password).toBe("x");
  });
});
