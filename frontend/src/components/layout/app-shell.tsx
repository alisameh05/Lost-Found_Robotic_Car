import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";

export function AppShell({ fixtureEnabled, modeLabel, activeSearch, priorityAction, children }: {
  fixtureEnabled: boolean; modeLabel?: string; activeSearch?: ReactNode; priorityAction?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="sidebar">
        <p className="brand">Lost &amp; Found</p>
        <p className="workspace-label">Local operator workspace</p>
        <Sidebar />
        {activeSearch}
        <p className="mode-label">
          {modeLabel ?? (fixtureEnabled ? "Fixture mode · Sample data · No robot connected" : "Backend unavailable · No robot connected")}
        </p>
      </aside>
      <main id="main-content" tabIndex={-1}>{priorityAction}{children}</main>
    </div>
  );
}
