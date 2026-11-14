import type { Health, Snapshot } from "@/generated/api-v1";
import type { ReadResult } from "@/lib/transport";

export function RuntimeStatus({ status, health }: { status: ReadResult<Snapshot>; health?: ReadResult<Health> }) {
  const diagnosis = health?.kind === "ok" ? health.data : null;
  const data = status.kind === "ok" ? status.data : null;
  const readiness = data?.readiness ?? diagnosis?.readiness;
  const loadError = status.kind === "api-error" ? status.error : null;
  return (
    <section className="panel" aria-labelledby="search-status">
      <h2 id="search-status">Search status</h2>
      {loadError && <p role="alert">{loadError.code} · {loadError.message}</p>}
      {status.kind === "unavailable" && <p role="alert">Runtime data unavailable</p>}
      {diagnosis?.initialization === "Starting" ? <p role="status">Initializing fixture application</p>
        : data && <p role="status">{data.runtime.effective_session_state ?? "No active search"}</p>}
      {diagnosis?.initialization === "Failed" && <p>Application initialization failed</p>}
      {data?.active_session && <p>{data.active_object?.name} · {data.active_session.control_mode}
        {data.runtime.persistence_pending && " · Save pending"}</p>}
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
