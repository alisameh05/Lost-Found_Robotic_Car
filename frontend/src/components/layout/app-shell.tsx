import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";

export function AppShell({ fixtureEnabled, children }: { fixtureEnabled: boolean; children: ReactNode }) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="sidebar">
        <p className="brand">Lost &amp; Found</p>
        <Sidebar />
        <p className="mode-label">
          {fixtureEnabled ? "Fixture mode · Sample data · No robot connected" : "Backend unavailable · No robot connected"}
        </p>
      </aside>
      <main id="main-content" tabIndex={-1}>{children}</main>
    </div>
  );
}
