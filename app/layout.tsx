import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Motion — Notion Expense Importer",
  description:
    "A browser-first, privacy-conscious importer that turns credit card statement PDFs into categorized Notion transactions.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-950 antialiased">{children}</body>
    </html>
  );
}
