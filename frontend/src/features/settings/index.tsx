import { Preview, PreviewLinks } from "@/components/layout/preview";

export function RetentionSettingsScreen() {
  return (
    <Preview title="Settings" description="Settings and retention changes are planned for a later phase.">
      <PreviewLinks links={[{ href: "/objects", label: "Back to Objects / History" }]} />
    </Preview>
  );
}
