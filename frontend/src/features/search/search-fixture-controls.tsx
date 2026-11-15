"use client";

import { Button } from "@/components/ui/button";
import { useRuntime } from "@/features/runtime";
import type { ControlMode } from "@/generated/api-v1";

export function SearchSaveControls() {
  const fixture = useRuntime()?.connection?.fixture;
  if (!fixture) return null;
  return <div className="control-row">
    <Button onClick={() => fixture.search.script("pending")}>Hold next search save</Button>
    <Button onClick={() => fixture.search.script("fail")}>Fail next search save</Button>
    <Button onClick={() => fixture.search.script("undelivered")}>Drop next search request</Button>
    <Button onClick={() => fixture.search.settle(true)}>Commit pending search save</Button>
    <Button onClick={() => fixture.search.settle(false)}>Fail pending search save</Button>
  </div>;
}

export function InputControls({ mode, disabled }: { mode: ControlMode; disabled: boolean }) {
  const connection = useRuntime()?.connection;
  const fixture = connection?.fixture;
  if (!fixture) return null;
  return <details>
    <summary>Workspace fixture controls</summary>
    <div className="control-row" aria-label="Fixture input observations">
      {(["forward", "backward", "left", "right"] as const).map((direction) => <Button key={direction} disabled={disabled}
        onClick={() => fixture.search.input(mode, direction)}>Hold {direction}</Button>)}
      <Button disabled={disabled} onClick={() => fixture.search.input(mode, "neutral")}>Release input</Button>
      <Button disabled={disabled} onClick={() => fixture.search.input(mode, "invalid")}>
        {mode === "Gestures" ? "Ambiguous gesture" : "Conflicting D-pad input"}
      </Button>
      {mode === "Controller" && <Button onClick={() => { void connection.runtime.emergency(); }}>PS4 Circle</Button>}
      <Button onClick={() => fixture.search.changeFrames("frozen")}>Freeze robot frames</Button>
      <Button onClick={() => fixture.search.changeFrames("live")}>Send fresh frames</Button>
      <Button onClick={fixture.search.disconnectEvents}>Disconnect search events</Button>
      <Button onClick={fixture.search.dropNextRelease}>Drop next lease release</Button>
    </div>
    <div className="control-row" aria-label="Fixture candidate observations">
      <Button disabled={disabled} onClick={() => fixture.search.observeCandidate("visible")}>Show sample candidate</Button>
      <Button onClick={() => fixture.search.observeCandidate("uncertain")}>Mark sample continuity uncertain</Button>
      <Button onClick={() => fixture.search.observeCandidate("exit")}>Observe sample candidate exit</Button>
      <Button disabled={disabled} onClick={() => fixture.search.observeCandidate("unprepared")}>Try unprepared sample candidate</Button>
      <Button disabled={disabled} onClick={() => fixture.search.observeCandidate("missing-media")}>Show sample with missing evidence</Button>
      <Button disabled={disabled} onClick={() => fixture.search.observeCandidate("corrupt-media")}>Show sample with corrupt evidence</Button>
    </div>
    <SearchSaveControls />
  </details>;
}
