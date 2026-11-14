import { Preview, PreviewLinks } from "@/components/layout/preview";

export function DevicesScreen() {
  return (
    <Preview title="Devices" description="Connection and readiness details are planned for a later phase.">
      <PreviewLinks links={[{ href: "/control-guide", label: "Preview the Control Guide" }]} />
    </Preview>
  );
}
