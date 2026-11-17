"use client";

import { Button } from "@/components/ui/button";
import { useRuntime, useRuntimeView } from "./runtime-provider";

export function RetentionFixtureControls() {
  const fixture = useRuntime()?.connection?.fixture;
  const { snapshot } = useRuntimeView();
  if (!fixture) return null;
  const active = snapshot?.active_session;
  const hold = fixture.retention.isSavePending();
  return <details>
    <summary>Retention fixture controls</summary>
    <div className="control-row">
      <Button onClick={() => fixture.advanceTime(60_000)}>Advance fixture clock 1 minute</Button>
      <Button onClick={() => fixture.advanceTime(604_800_000)}>Advance fixture clock 7 days</Button>
      <Button onClick={fixture.retention.holdNextEvidenceRead}>Hold next captured evidence read</Button>
      <Button onClick={fixture.retention.releaseEvidenceRead}>Deliver held evidence read</Button>
      <Button onClick={() => fixture.retention.save("Hold")}>Hold next retention save</Button>
      <Button disabled={!hold} onClick={() => fixture.retention.save("Commit")}>Deliver retention save</Button>
      <Button disabled={!hold} onClick={() => fixture.retention.save("Lose response")}>Lose retention save response</Button>
      <Button disabled={!hold} onClick={() => fixture.retention.save("Fail")}>Fail retention save</Button>
      <Button disabled={snapshot?.retention.deletion.status !== "Pending"} onClick={() => fixture.retention.cleanup(false)}>Complete sample deletion</Button>
      <Button disabled={snapshot?.retention.deletion.status !== "Pending"} onClick={() => fixture.retention.cleanup(true)}>Fail sample deletion</Button>
      <Button disabled={!!active} onClick={() => fixture.retention.activateSearch("Searching")}>Activate Searching fixture</Button>
      <Button disabled={!!active} onClick={() => fixture.retention.activateSearch("Paused")}>Activate Paused fixture</Button>
      <Button disabled={!active} onClick={() => fixture.retention.endSearch()}>End sample session</Button>
    </div>
  </details>;
}
