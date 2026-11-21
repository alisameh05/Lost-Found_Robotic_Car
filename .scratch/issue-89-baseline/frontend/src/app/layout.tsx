import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { readFixtureShell, readRecordsShell, RuntimeProvider } from "@/features/runtime";
import { fixtureHarnessEnabled, readConfig } from "@/lib/config";
import "./globals.css";

export const metadata: Metadata = { title: "Lost & Found", description: "Local operator workspace for Lost & Found." };

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const { fixtureEnabled, recordsEnabled, backendBaseUrl } = readConfig();
  const FixtureShell = fixtureEnabled ? await readFixtureShell() : undefined;
  const RecordsShell = recordsEnabled ? await readRecordsShell() : undefined;
  return (
    <html lang="en">
      <body>
        {FixtureShell ? <FixtureShell harnessEnabled={fixtureHarnessEnabled()}>{children}</FixtureShell>
          : RecordsShell ? <RecordsShell backendBaseUrl={backendBaseUrl}>{children}</RecordsShell> : (
          <RuntimeProvider><AppShell fixtureEnabled={false}>{children}</AppShell></RuntimeProvider>
        )}
      </body>
    </html>
  );
}
