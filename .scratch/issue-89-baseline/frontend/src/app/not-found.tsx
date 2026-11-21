import { Preview, PreviewLinks } from "@/components/layout/preview";

export default function NotFound() {
  return (
    <Preview title="Page not found" description="This address does not match a destination or an available sample record.">
      <PreviewLinks links={[{ href: "/", label: "Dashboard" }, { href: "/objects", label: "Objects / History" }]} />
    </Preview>
  );
}
