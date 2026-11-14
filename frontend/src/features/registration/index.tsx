import { Preview, PreviewLinks } from "@/components/layout/preview";

export function RegistrationScreen() {
  return (
    <Preview title="Register Object" description="Object information and target selection will share this page when registration is implemented.">
      <PreviewLinks links={[{ href: "/objects", label: "Back to Objects / History" }]} />
    </Preview>
  );
}
