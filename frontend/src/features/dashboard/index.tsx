import Link from "next/link";
import { DataUnavailable, Preview, PreviewLinks } from "@/components/layout/preview";
import { DashboardRuntime } from "@/features/runtime";

export function DashboardScreen({ fixtureEnabled }: { fixtureEnabled: boolean }) {
  if (!fixtureEnabled) return <DataUnavailable />;

  return (
    <Preview
      title="Dashboard"
      description="Preview navigation for the local operator workspace."
      actions={<Link className="button button--secondary" href="/objects/new">Preview registration</Link>}
    >
      <DashboardRuntime />
      <PreviewLinks links={[
        { href: "/objects", label: "Browse sample history" },
        { href: "/devices", label: "Preview Devices" },
      ]} />
    </Preview>
  );
}
