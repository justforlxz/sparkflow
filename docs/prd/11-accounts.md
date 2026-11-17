# 11 账号与会话

> 依赖：无（属于架构基线，与 10 功能开关同级）｜ 被所有业务节点依赖

## 目标

用账号登录保护整个应用。现在单账号自用；将来按工作区组织、支持多个账号（演进路径见 ADR 0006）。

## 范围

包含：用户表、会话表、注册（仅首个账号）、登录、登出、会话校验、密码重置命令、
未登录时的统一行为（页面跳转 / 接口 401）。

不包含：开放注册、邀请、邮箱验证、找回密码邮件、第三方登录、工作区与成员管理（将来加）。

## 设计契约

### 数据

`user`：id、email（唯一，存储前转小写）、name、password_hash、created_at、last_login_at、disabled_at

`session`：id（主键）、token_hash（唯一索引）、user_id、created_at、expires_at、revoked_at、user_agent

- `password_hash` 用 Node 内置 `scrypt`，格式 `scrypt$N$r$p$salt$hash`（参数自描述，便于将来提高强度）。
- 会话令牌是 32 字节随机值的 base64url；**库里只存它的 SHA-256**，原文只在 cookie 里。
- 会话有效期 30 天，不做滑动续期。

### MUST

1. 除白名单外，所有页面与接口都要求登录。
   白名单：`/login`、`/api/health`、`/api/auth/login`、`/api/auth/register`、`/api/auth/logout`。
2. 未登录访问页面 → 302 到 `/login?next=<原路径>`；未登录访问接口 → **401 JSON 信封**
   （`error.code = UNAUTHORIZED`），不能返回 302 或 HTML。
3. `next` 参数只接受站内相对路径，拒绝协议、`//` 开头与跨站值，避免开放重定向。
4. 注册只在「用户表为空」时开放，用来创建第一个账号；之后返回 403
   （`error.code = FORBIDDEN`，说明「已存在账号，请联系管理员」）。
5. 登录失败统一返回「邮箱或密码不正确」，不区分账号不存在与密码错误。
6. 同一 IP 在 5 分钟内失败 5 次后返回 429，并在响应里说明稍后再试。
7. 登出必须把当前 session 置为 revoked 并清除 cookie；此后同一 cookie 再访问必须被拒。
8. 重置密码后，该用户的全部会话失效（这是「改密码 = 踢下线」的唯一实现）。
9. 密码最短 10 个字符；不接受与邮箱相同的密码。
10. 数据库、日志、错误信息中不得出现明文密码或会话令牌原文。

### SHOULD

- 会话校验集中在服务端函数 `getCurrentUser()`；页面与接口只调用它，不自己解析 cookie。
- `proxy.ts` 只做「无 cookie 直接跳登录」的快速判断，不查数据库；
  真正的有效性校验在读数据的服务端函数里完成（避免每请求一次数据库往返）。
- 登录页显示应用名与一行说明，成功后跳回 `next` 或 `/`。
- 提供 `pnpm auth:reset-password <email>`：交互式输入新密码，写库并撤销全部会话，
  用于忘记密码（自托管无邮件通道）。

### MAY

- 记住上次登录的邮箱（仅前端 localStorage 存邮箱，绝不含密码或令牌）。
- 首次注册成功后自动登录并进入工作台。

### MUST NOT

- 不得把密码或令牌明文写库、写日志、写错误信息。
- 不得使用 JWT 等无法撤销的自包含令牌（本项目的登出与改密码需要真失效）。
- 不得在前端做权限判断当作保护（服务端必须独立校验）。
- 不得为「将来的多工作区」现在就在业务表加过滤列（ADR 0006）。

## 数据与接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/auth/me` | 当前用户与是否已存在账号（供登录页决定显示登录还是首次注册） |
| POST | `/api/auth/register` | 首个账号注册；已存在账号时 403 |
| POST | `/api/auth/login` | 登录，设置会话 cookie |
| POST | `/api/auth/logout` | 登出，撤销会话 |
| GET | `/api/auth/sessions` | （MAY）当前账号的会话列表，用于排查 |

页面：`/login` 承载登录与首次注册两种状态。

## 验收标准

| 编号 | 断言 | 自动化用例 |
| --- | --- | --- |
| AC-11-1 | 空库首次访问被引导到 `/login`，注册成功后自动登录并进入工作台 | `tests/e2e/accounts.spec.ts` |
| AC-11-2 | 已存在账号时再次调用注册接口返回 403，用户数不变 | 同上 |
| AC-11-3 | 正确密码登录成功；错误密码返回统一文案「邮箱或密码不正确」，不暴露账号是否存在 | 同上 |
| AC-11-4 | 未登录访问页面被重定向到 `/login?next=...`；未登录访问 `/api/collections` 返回 401 JSON | 同上 |
| AC-11-5 | 登录后访问 `next` 指向的站内路径；`next=https://evil.example` 被忽略并回首页 | 同上 |
| AC-11-6 | 登出后再访问受保护页面被重定向；直接用旧 cookie 调接口返回 401 | 同上 |
| AC-11-7 | 会话表里的 `expires_at` 过期后，请求被拒（改库模拟） | 单测 |
| AC-11-8 | 同一 IP 连续 5 次密码错误后，第 6 次返回 429 | 单测（限速器）+ e2e |
| AC-11-9 | `pnpm auth:reset-password` 改密码后，旧会话全部失效、新密码可登录 | 集成测试 |
| AC-11-10 | 数据库中搜索明文密码与 cookie 令牌原文，命中 0 次 | 单测 + 人工 grep |

## 验证方式

```bash
pnpm test        # scrypt 校验、会话过期/撤销、限速、next 白名单
pnpm test:e2e    # tests/e2e/accounts.spec.ts
pnpm auth:reset-password someone@example.com   # 人工验证一次
```
