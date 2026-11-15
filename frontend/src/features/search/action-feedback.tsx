"use client";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/feedback";
import type { SearchFeedback } from "@/features/runtime";

export function ActionFeedback({ label, feedback, retry, canRetryFailed = false }: {
  label: string; feedback?: SearchFeedback; retry(): void; canRetryFailed?: boolean;
}) {
  if (!feedback) return null;
  const { stage } = feedback;
  const title = stage === "sending" ? label : stage === "pending" ? "Save pending" : stage === "unknown" ? "Action outcome unconfirmed"
    : stage === "failed" ? "Save failed" : stage === "rejected" ? "Action rejected" : "Action saved";
  return <div role="status">
    <Notice title={title} tone={stage === "failed" || stage === "rejected" ? "danger" :
      stage === "committed" ? "success" : "info"}>
      {"message" in feedback ? feedback.message : stage === "unknown" ? "Retry to check the original request." :
        stage === "pending" ? "The fixture accepted the action and is still saving it." : null}
    </Notice>
    {(stage === "unknown" || stage === "pending" || (stage === "failed" && feedback.retryable && canRetryFailed)) &&
      <Button onClick={retry}>Retry original action</Button>}
  </div>;
}
