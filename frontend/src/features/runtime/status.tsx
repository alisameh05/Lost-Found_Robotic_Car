"use client";

import { lazy, Suspense } from "react";
import { Button } from "@/components/ui/button";
import { LoadingState, Notice } from "@/components/ui/feedback";
import { useRuntime, useRuntimeView } from "./runtime-provider";

const FixtureInspector = lazy(() => import("./fixture-inspector").then((module) => ({ default: module.FixtureInspector })));

export function DashboardRuntime() {
  const harnessEnabled = useRuntime()?.harnessEnabled;
  return <>
    {harnessEnabled && <Suspense fallback={<LoadingState label="Loading fixture scenarios" />}><FixtureInspector /></Suspense>}
    <RuntimeStatus />
  </>;
}

function RuntimeStatus() {
  const runtime = useRuntime()?.connection?.runtime;
  const { snapshot: data, failedRead, health, loading } = useRuntimeView();
  const readiness = data?.readiness ?? health?.readiness;
  return (
    <section className="panel" aria-labelledby="search-status">
      <h2 id="search-status">Search status</h2>
      {loading && <LoadingState label="Loading fixture snapshot" />}
      {failedRead && <Notice title="Runtime data unavailable" tone="danger" role="alert">
        {failedRead.kind === "api-error" && `${failedRead.error.code} · ${failedRead.error.message}`}
      </Notice>}
      {failedRead && runtime && <Button onClick={() => { void runtime.refresh(); }}>Retry snapshot</Button>}
      {health?.initialization === "Starting" ? <p role="status">Initializing fixture application</p>
        : data && <p role="status">{data.runtime.effective_session_state ?? "No active search"}</p>}
      {health?.initialization === "Failed" && <p>Application initialization failed</p>}
      {data?.active_session && <>
        <p>{data.active_object?.name} · {data.active_session.control_mode}</p>
        <p>Committed session · {data.active_session.state}</p>
        <p>Motion permission · {data.runtime.motion_permission}{data.runtime.persistence_pending && " · Save pending"}</p>
      </>}
      {readiness && (
        <>
          <h3>Readiness</h3>
          <p>Gestures {readiness.can_start.Gestures ? "ready" : "unavailable"} · Controller {readiness.can_start.Controller ? "ready" : "unavailable"}</p>
          <details>
            <summary>Readiness components</summary>
            <dl className="fixture-readiness">
              {readiness.components.map(({ component, status }) => <div key={component}><dt>{component}</dt><dd>{status}</dd></div>)}
            </dl>
          </details>
        </>
      )}
      {data && <p>Proximity advisory · {data.proximity.state}</p>}
    </section>
  );
}
