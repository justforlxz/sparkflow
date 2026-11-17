"use server";

import { redirect } from "next/navigation";
import { logoutCurrentSession } from "@/modules/auth/service";

export async function logoutAction(): Promise<void> {
  await logoutCurrentSession();
  redirect("/login");
}
