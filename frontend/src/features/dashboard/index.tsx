import { DataUnavailable, Preview, PreviewLinks } from "@/components/layout/preview";
import { readApplication, readFixtureInspector, RuntimeStatus } from "@/features/runtime";

export async function DashboardScreen() {
  const application = await readApplication();
  const result = await application.get("/snapshot");
  if (result.kind !== "ok") return <DataUnavailable />;
  const FixtureInspector = await readFixtureInspector();

  return (
    <Preview title="Dashboard" description="Preview navigation for the local operator workspace. Dashboard summaries are planned for a later phase.">
      {FixtureInspector ? <FixtureInspector /> : <RuntimeStatus status={result} />}
      <PreviewLinks links={[
        { href: "/objects", label: "Browse sample history" },
        { href: "/objects/new", label: "Preview registration" },
        { href: "/devices", label: "Preview Devices" },
      ]} />
    </Preview>
  );
}
