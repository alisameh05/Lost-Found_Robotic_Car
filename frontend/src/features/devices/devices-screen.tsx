"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import layout from "@/components/layout/support-page.module.css";
import { Button } from "@/components/ui/button";
import { LoadingState, Notice } from "@/components/ui/feedback";
import { useEligibleSearchSetup, useRefreshRuntime, useRuntime, useRuntimeView } from "@/features/runtime";
import type { Component, ControlMode, Health } from "@/generated/api-v1";
import { searchSetupHref, supportHref, type SearchSetupContext } from "@/lib/search-setup-context";
import { InactiveInput, PathRow, paths, ProximityAdvisory } from "./device-observations";
import styles from "./devices.module.css";
import { describeDeviceReadiness, deviceReadinessView, modeLabels } from "./readiness-summary";

const connectionAndMatchingComponents = new Set<Component["component"]>(["Command", "RobotVideo", "AI"]);

export function ReadinessNotice({ loading, disconnected, health, snapshotFailed, summary, mode, compact = false }: {
  loading: boolean;
  disconnected?: boolean;
  health?: Health;
  snapshotFailed: boolean;
  summary: ReturnType<typeof describeDeviceReadiness>;
  mode: ControlMode;
  compact?: boolean;
}) {
  if (loading) return <LoadingState label="Loading device readiness" announce={false} />;
  if (disconnected) return <Notice title="Backend unavailable" tone="danger">Connect the local application to see device observations.</Notice>;
  if (health?.initialization === "Starting" || health?.storage_integrity === "Reconciling") {
    return <Notice title="Initializing services" tone="warning">
      Checking availability. New searches remain unavailable while required services and devices initialize.
    </Notice>;
  }
  if (health?.initialization === "Failed" || health?.process_status === "Degraded" || health?.storage_integrity === "Unavailable") {
    return <Notice title="Device readiness degraded" tone="danger">
      {health.storage_integrity === "Unavailable"
        ? "Managed storage is unavailable. Restore storage access and retry readiness."
        : "The local application reported a service problem. Check the service and retry readiness."}
      {snapshotFailed && " The snapshot is unavailable. Showing the reported health observations."}
    </Notice>;
  }
  if (snapshotFailed || !health || summary.status === "Unknown") {
    return <Notice title={health || summary.status !== "Unknown" ? "Device readiness incomplete" : "Device readiness unavailable"} tone="danger">
      {snapshotFailed && health ? "The snapshot is unavailable. Showing the reported health observations."
        : "Some observations could not be retrieved. Check the local application and retry readiness."}
    </Notice>;
  }

  const label = modeLabels[mode];
  if (summary.status === "Unavailable") {
    const first = summary.unavailable[0];
    const detail = compact ? undefined : <>Check {summary.unavailable.map((component) => paths[component].label).join(", ")}.
      {" "}{paths[first].check}</>;
    return <Notice title={`${label} requirements unavailable`} tone="danger">{detail}</Notice>;
  }
  if (summary.status === "Initializing") {
    return <Notice title={`${label} requirements initializing`} tone="warning">
      Wait for the required paths to finish initializing, then refresh readiness.
    </Notice>;
  }
  return <Notice title={`${label} requirements ready`} tone="success">
    {!compact && "All required paths report Ready. The search workspace checks Start and Resume eligibility separately."}
  </Notice>;
}

function PathList({ observations }: { observations: Component[] }) {
  return <ul className={styles.paths}>{observations.map((observation) =>
    <PathRow key={observation.component} observation={observation} />)}</ul>;
}

export function DevicesScreen({ setup }: { setup?: SearchSetupContext }) {
  const view = useRuntimeView();
  const runtimeState = useRuntime();
  const refresh = useRefreshRuntime();
  const { context, checking } = useEligibleSearchSetup(setup);
  const [inspectedMode, setInspectedMode] = useState<ControlMode>("Gestures");
  const setupMode = context?.mode ?? (checking ? setup?.mode : undefined);
  const { snapshot, active, activeModeUnavailable, mode, readiness, summary } = deviceReadinessView(view, setupMode ?? inspectedMode);
  const canRefresh = !view.disconnected && runtimeState;

  return (
    <div className={layout.page}>
      <PageHeader title="Devices" description="Check the paths required for the selected control mode."
        actions={active ? (
          <div className={styles.mode}>
            <strong>{modeLabels[mode]}</strong>
            <p>Locked to active search · {snapshot?.runtime.effective_session_state ?? active.state}</p>
          </div>
        ) : activeModeUnavailable ? (
          <div className={styles.mode}>
            <strong>Active search · {view.health?.active_session_state}</strong>
            <p>Mode unavailable. Retry readiness to identify the locked mode.</p>
          </div>
        ) : setupMode ? (
          <div className={styles.mode}>
            <strong>{modeLabels[mode]}</strong>
            <p>{checking ? "Checking Search Setup" : "From Search Setup"}</p>
          </div>
        ) : !view.disconnected && (
          <div className={styles.mode}>
            <label htmlFor="readiness-mode">Readiness mode</label>
            <select id="readiness-mode" value={mode} onChange={(event) => setInspectedMode(
              event.target.value === "Controller" ? "Controller" : "Gestures",
            )}>
              <option value="Gestures">Gestures</option>
              <option value="Controller">Controller (PS4)</option>
            </select>
            <p>For inspection only</p>
          </div>
        )}
      />
      <div className={styles.noticeRow}>
        <div role="status">
          <ReadinessNotice loading={view.loading} disconnected={view.disconnected} health={view.health}
            snapshotFailed={!!view.failedRead} summary={summary} mode={mode} />
        </div>
        {canRefresh && (
          <Button onClick={refresh} pending={view.loading}>
            {view.loading ? "Reading readiness" : view.failedRead || !view.health || view.health.process_status === "Degraded"
              ? "Retry readiness" : "Refresh readiness"}
          </Button>
        )}
      </div>
      <div className={layout.columns}>
        {activeModeUnavailable && readiness && (
          <section aria-labelledby="reported-readiness-title">
            <h2 id="reported-readiness-title">Reported readiness</h2>
            <PathList observations={readiness.components} />
          </section>
        )}
        {summary.selected && (
          <section aria-labelledby="required-title">
            <h2 id="required-title">Required for {modeLabels[mode]}</h2>
            <div className={styles.groups}>
              <div className={styles.selected}>
                <h3>Selected-mode input</h3>
                <PathList observations={[summary.selected]} />
              </div>
              <div>
                <h3>Shared connections and matching</h3>
                <PathList observations={summary.shared.filter(({ component }) => connectionAndMatchingComponents.has(component))} />
              </div>
              <div>
                <h3>Shared application prerequisites</h3>
                <PathList observations={summary.shared.filter(({ component }) => !connectionAndMatchingComponents.has(component))} />
              </div>
            </div>
          </section>
        )}
        <div className={styles.sideColumn}>
          {summary.inactive && (
            <section aria-labelledby="inactive-title">
              <h2 id="inactive-title">Inactive in this mode</h2>
              <InactiveInput input={summary.inactive} />
            </section>
          )}
          <ProximityAdvisory reading={snapshot?.proximity} />
          {active && <p className={styles.muted}>For recovery, return to the active search to acknowledge restored causes and select Resume explicitly.</p>}
        </div>
      </div>
      <nav aria-label="Device links" className={layout.footer}>
        <Link className="button button--secondary" href={supportHref("/control-guide", checking ? setup : context)}>Open Control Guide</Link>
        {context && <Link className="button button--primary" href={searchSetupHref(context)}>
          <ArrowRight size={18} aria-hidden="true" /> Return to Search Setup
        </Link>}
      </nav>
      {!view.disconnected && <p className={layout.sample}>Sample device observations. No live device check.</p>}
    </div>
  );
}
