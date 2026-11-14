import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { readFixtureShell, RuntimeProvider } from "@/features/runtime";
import { fixtureHarnessEnabled, readConfig } from "@/lib/config";
import "./globals.css";

export const metadata: Metadata = { title: "Lost & Found", description: "Local operator workspace for Lost & Found." };

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const { fixtureEnabled } = readConfig();
  const FixtureShell = fixtureEnabled ? await readFixtureShell() : undefined;
  return (
    <html lang="en">
      <body>
        {FixtureShell ? <FixtureShell harnessEnabled={fixtureHarnessEnabled()}>{children}</FixtureShell> : (
          <RuntimeProvider><AppShell fixtureEnabled={false}>{children}</AppShell></RuntimeProvider>
        )}
      </body>
    </html>
  );
}
