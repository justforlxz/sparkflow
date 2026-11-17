import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "拾光 · AI 内容工坊",
  description: "个人自用的 AI 图文内容创作工具",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
