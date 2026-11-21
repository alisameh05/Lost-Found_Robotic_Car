import { Notice } from "@/components/ui/feedback";
import type { DeletionProgress } from "@/generated/api-v1";

const count = (value: number, noun: string) => `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;

export function DeletionNotice({ status }: { status: DeletionProgress }) {
  if (status.status === "Complete") return <Notice tone="success" title="Deletion complete" />;
  const failed = status.status === "Failed";
  return <Notice tone={failed ? "danger" : "warning"} title={failed ? "Deletion failed" : "Deletion pending"}>
    Access to expired records has ended. Cleanup still has {count(status.remaining_objects, "object")} and {count(status.remaining_files, "file")} remaining.
  </Notice>;
}
