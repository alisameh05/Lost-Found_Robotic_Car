"use client";

import { CircleCheck, Octagon, Pause, Scan, Search, Square, TriangleAlert, VideoOff } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { PageActions } from "@/components/layout/page-header";
import { ModelessPanel, Panel } from "@/components/layout/panel";
import { Button } from "@/components/ui/button";
import { Choice, Field } from "@/components/ui/field";
import { Notice, RetrievalFeedback, SaveFeedback, StatusBadge, type SaveState } from "@/components/ui/feedback";
import type { createFixtureHarness } from "@/lib/create-transport";

type OpenControls = Awaited<ReturnType<typeof createFixtureHarness>>["openControls"];
type ControlScript = ReturnType<OpenControls>;
type SampleOutcome = Parameters<ControlScript["submit"]>[0];

export function ControlSpecimens({ open, media }: { open: OpenControls; media: ReactNode }) {
  const mediaId = useId();
  const script = useRef<{ operations: ControlScript; lifetime: AbortController }>(null);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [slotReached, setSlotReached] = useState(false);
  const [readState, setReadState] = useState<"idle" | "loading" | "unavailable" | "empty">("idle");

  useEffect(() => {
    const lifetime = new AbortController();
    script.current = { operations: open(), lifetime };
    return () => { lifetime.abort(); script.current = null; };
  }, [open]);

  async function read() {
    const current = script.current;
    if (!current || readState === "loading") return;
    const { operations, lifetime: { signal } } = current;
    setReadState("loading");
    try {
      const outcome = await operations.read(signal);
      if (!signal.aborted) setReadState(outcome);
    } catch {
      if (!signal.aborted) setReadState("unavailable");
    }
  }

  return (
    <section className="control-specimens" aria-labelledby="control-specimens-title">
      <div className="specimen-heading">
        <div>
          <h2 id="control-specimens-title">Shared control specimens</h2>
          <p>Development samples for testing fields, feedback and media.</p>
        </div>
        <PageActions priority={
          <Button
            onClick={() => setSlotReached(true)}
          >
            <Octagon aria-hidden="true" size={18} /> Check reserved action slot
          </Button>
        }>
          <Button aria-expanded={mediaOpen} aria-controls={mediaId} onClick={() => setMediaOpen(!mediaOpen)}>
            {mediaOpen ? "Hide sample media" : "Inspect sample media"}
          </Button>
        </PageActions>
      </div>
      <div role="status">{slotReached && <p className="control-hint">Sample action slot reached.</p>}</div>
      <div id={mediaId} hidden={!mediaOpen}>
        {mediaOpen && <ModelessPanel id={`${mediaId}-panel`} title="Sample media preview">{media}</ModelessPanel>}
      </div>

      <div className="specimen-grid">
        <SaveSpecimen script={script} />
        <Panel aria-labelledby="sample-read-title">
          <h3 id="sample-read-title">Sample retrieval</h3>
          <RetrievalFeedback
            state={readState} onRead={read}
            loadingLabel="Loading sample data" failedLabel="Sample data unavailable"
            emptyDetail="The sample read returned no records."
          />

          <h3 className="section-spacing">Sample statuses</h3>
          <div className="status-list">
            <StatusBadge icon={Search}>Lost</StatusBadge>
            <StatusBadge tone="success" icon={CircleCheck}>Found</StatusBadge>
            <StatusBadge tone="info" icon={Scan}>Searching</StatusBadge>
            <StatusBadge tone="warning" icon={Pause}>Paused</StatusBadge>
            <StatusBadge icon={Square}>Ended</StatusBadge>
            <StatusBadge tone="warning" icon={TriangleAlert}>Unavailable</StatusBadge>
            <StatusBadge tone="danger" icon={VideoOff}>Not live</StatusBadge>
          </div>
          <Notice title="Proximity advisory" tone="warning">Sample reading unavailable. Advisory only.</Notice>
          <p className="technical-value">
            <span className="control-hint">Sample elapsed time</span>
            <time dateTime="PT4M32S">04:32</time>
          </p>
        </Panel>
      </div>
    </section>
  );
}

function SaveSpecimen({ script }: {
  script: { readonly current: { operations: ControlScript; lifetime: AbortController } | null };
}) {
  const [label, setLabel] = useState("");
  const [validation, setValidation] = useState(false);
  const [outcome, setOutcome] = useState<SampleOutcome>("committed");
  const [feedback, setFeedback] = useState<SaveState>();
  const submitting = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const pending = feedback?.kind === "pending";
  const error = validation && !label.trim() ? "Enter a sample label." : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !script.current) return;
    if (!label.trim()) {
      setValidation(true);
      field.current?.focus();
      return;
    }

    const { operations, lifetime: { signal } } = script.current;
    submitting.current = true;
    setValidation(false);
    setFeedback({ kind: "pending" });
    try {
      const result = await operations.submit(outcome, signal);
      if (signal.aborted) return;
      setFeedback(result === "committed"
        ? { kind: "committed", detail: "The scripted response confirmed the sample save." }
        : { kind: "failed", detail: "The scripted response reported that the sample could not be saved." });
    } catch {
      if (!signal.aborted) setFeedback({ kind: "failed", detail: "The sample request could not be completed." });
    } finally {
      submitting.current = false;
    }
  }

  return (
    <Panel aria-labelledby="sample-action-title">
      <h3 id="sample-action-title">Sample submission</h3>
      <form className="sample-form" noValidate onSubmit={submit}>
        <Field
          ref={field}
          label="Sample label"
          description="Enter any label to try the sample submission."
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          required
          error={error}
        />
        {error && <div className="visually-hidden" role="alert">{error}</div>}
        <div className="specimen-fields">
          <Field type="search" label="Sample search" description="Example search field." />
          <Field type="number" label="Sample quantity" description="Example number field." min={1} defaultValue={1} />
        </div>
        <Choice type="checkbox" label="Include sample note" description="Example checkbox." />
        <fieldset className="specimen-options">
          <legend>Scripted save result</legend>
          <Choice type="radio" name="sample-result" label="Commit" checked={outcome === "committed"} onChange={() => setOutcome("committed")} />
          <Choice type="radio" name="sample-result" label="Fail" checked={outcome === "failed"} onChange={() => setOutcome("failed")} />
        </fieldset>
        <div className="control-row">
          <Button ref={saveButton} type="submit" variant="primary" pending={pending}>Save sample</Button>
          {pending && <Button onClick={() => {
            saveButton.current?.focus();
            script.current?.operations.deliver();
          }}>Deliver save result</Button>}
          <Button variant="quiet" onClick={() => {
            setLabel("");
            setValidation(false);
            setFeedback(undefined);
          }} disabledReason={pending ? "Wait for the sample result before clearing the label." : undefined}>
            Clear sample label
          </Button>
        </div>
        <SaveFeedback state={feedback} />
      </form>
      <div className="blocked-action">
        <Button variant="destructive" disabledReason="A removable sample has not been selected.">Remove sample</Button>
      </div>
    </Panel>
  );
}
