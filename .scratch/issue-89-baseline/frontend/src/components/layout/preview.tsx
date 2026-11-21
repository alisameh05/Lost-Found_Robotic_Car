import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "./page-header";
import { Panel } from "./panel";

export function Preview({
  title, description, actions, children,
}: { title: string; description: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <>
      <PageHeader title={title} description={description} context="Phase 01 preview" actions={actions} />
      {children}
    </>
  );
}

export function PreviewLinks({ links }: { links: { href: string; label: string }[] }) {
  return (
    <Panel>
      <h2>Related previews</h2>
      <ul className="preview-links">
        {links.map(({ href, label }) => <li key={href}><Link href={href}>{label}</Link></li>)}
      </ul>
    </Panel>
  );
}

export function DataUnavailable() {
  return (
    <Preview title="Application data unavailable" description="Connect to a backend when integration becomes available, or explicitly enable fixture mode to preview sample data." />
  );
}
