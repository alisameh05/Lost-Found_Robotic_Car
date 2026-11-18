import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { Notice } from "@/components/ui/feedback";

export function SearchUnavailable({ title }: { title: string }) {
  return <>
    <PageHeader title={title} />
    <Notice title="Search unavailable" tone="warning">
      The application is disarmed. <Link href="/devices">Check device and qualification status</Link>.
    </Notice>
    <Link className="button button--secondary" href="/objects">Back to Objects</Link>
  </>;
}
