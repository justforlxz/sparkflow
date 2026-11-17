/**
 * 重置密码并撤销该账号全部会话（docs/prd/11-accounts.md 的 SHOULD）。
 * 用法：pnpm auth:reset-password <email>
 */
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { getDb } from "@/lib/db";
import { resetPassword } from "@/modules/auth/service";

interface MutableWriteToOutput {
  _writeToOutput: (chunk: string) => void;
}

function askHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    const mutable = rl as unknown as MutableWriteToOutput;
    const original = mutable._writeToOutput;
    // 覆盖回显：输入的字符不写到终端。
    mutable._writeToOutput = () => {};

    stdout.write(label);
    rl.question("", (answer) => {
      mutable._writeToOutput = original;
      rl.close();
      stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error("用法：pnpm auth:reset-password <email>");
    process.exitCode = 1;
    return;
  }

  const password = await askHidden("新密码（输入不回显）：");
  if (!password) {
    console.error("密码不能为空");
    process.exitCode = 1;
    return;
  }

  try {
    const user = await resetPassword(email, password);
    console.log(`已重置 ${user.email} 的密码，并撤销其全部会话。`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await getDb().$disconnect();
  }
}

void main();
