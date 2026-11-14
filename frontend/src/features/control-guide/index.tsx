import { Preview, PreviewLinks } from "@/components/layout/preview";

export function ControlGuideScreen() {
  return (
    <Preview title="Control Guide" description="The operator checklist and control mappings are planned for a later phase.">
      <PreviewLinks links={[{ href: "/devices", label: "Preview Devices" }]} />
    </Preview>
  );
}
