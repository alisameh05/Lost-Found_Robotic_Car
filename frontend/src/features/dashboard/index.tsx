import Link from "next/link";
import { DataUnavailable, Preview, PreviewLinks } from "@/components/layout/preview";
import { readApplication, readFixtureInspector, RuntimeStatus } from "@/features/runtime";

export async function DashboardScreen() {
  const application = await readApplication();
  const result = await application.get("/snapshot");
  if (result.kind !== "ok") return <DataUnavailable />;
  const FixtureInspector = await readFixtureInspector();

  return (
    <Preview
      title="Dashboard"
      description="Preview navigation for the local operator workspace."
      actions={<Link className="button button--secondary" href="/objects/new">Preview registration</Link>}
    >
      {FixtureInspector ? <FixtureInspector /> : <RuntimeStatus status={result} />}
      <PreviewLinks links={[
        { href: "/objects", label: "Browse sample history" },
        { href: "/devices", label: "Preview Devices" },
      ]} />
    </Preview>
  );
}
