import Link from "next/link";
import type { ReactNode } from "react";

export function Preview({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <>
      <header className="page-header">
        <p className="phase-label">Phase 01 preview</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      {children}
    </>
  );
}

export function PreviewLinks({ links }: { links: { href: string; label: string }[] }) {
  return (
    <section className="panel">
      <h2>Related previews</h2>
      <ul className="preview-links">
        {links.map(({ href, label }) => <li key={href}><Link href={href}>{label}</Link></li>)}
      </ul>
    </section>
  );
}

export function DataUnavailable() {
  return (
    <Preview title="Application data unavailable" description="Connect to a backend when integration becomes available, or explicitly enable fixture mode to preview sample data." />
  );
}
