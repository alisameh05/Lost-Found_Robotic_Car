import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { isFixtureMode } from "@/lib/config";
import "./globals.css";

export const metadata: Metadata = { title: "Lost & Found", description: "Local operator workspace for Lost & Found." };

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="en">
      <body><AppShell fixtureEnabled={isFixtureMode()}>{children}</AppShell></body>
    </html>
  );
}
