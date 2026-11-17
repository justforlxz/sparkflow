import { execFileSync } from "node:child_process";

/** 集成测试连真实 PostgreSQL：先把迁移应用到位，失败直接中止。 */
export default function setup(): void {
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { stdio: "inherit" });
}
