import { DataUnavailable, Preview, PreviewLinks } from "@/components/layout/preview";
import { readApplication } from "@/features/runtime";

export async function DashboardScreen() {
  const application = await readApplication();
  const result = await application.get("/snapshot");
  if (result.kind !== "ok") return <DataUnavailable />;
  const session = result.data.active_session;

  return (
    <Preview title="Dashboard" description="Preview navigation for the local operator workspace. Dashboard summaries are planned for a later phase.">
      <section className="panel">
        <h2>Search status</h2>
        <p>{session ? session.state : "No active search"}</p>
      </section>
      <PreviewLinks links={[
        { href: "/objects", label: "Browse sample history" },
        { href: "/objects/new", label: "Preview registration" },
        { href: "/devices", label: "Preview Devices" },
      ]} />
    </Preview>
  );
}
