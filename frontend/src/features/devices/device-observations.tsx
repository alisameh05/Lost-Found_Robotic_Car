import {
  Bluetooth, Database, Gamepad2, Monitor, PanelsTopLeft, Radar, ScanSearch, Server, ShieldCheck, Video, Webcam,
} from "lucide-react";
import { Panel } from "@/components/layout/panel";
import { StatusBadge } from "@/components/ui/feedback";
import type { Component, ComponentName, ErrorCode, Proximity } from "@/generated/api-v1";
import styles from "./devices.module.css";

export const paths = {
  Backend: { label: "Backend service", icon: Server, check: "Check the local application service and wait for startup to finish." },
  Storage: { label: "Managed storage", icon: Database, check: "Wait for storage reconciliation. If it fails, restore storage access and check readiness again." },
  Command: { label: "Robot command connection", icon: Bluetooth, check: "Check that the command device is powered, its configured connection is available, and no other app is using it." },
  RobotVideo: { label: "Robot camera", icon: Video, check: "Check that the camera stream is reachable on local Wi-Fi and is providing fresh frames." },
  DisplayedRobotVideo: { label: "Displayed robot video", icon: Monitor, check: "In the search workspace, check that fresh robot frames are actually visible. A frozen picture cannot satisfy this requirement." },
  Webcam: { label: "Laptop webcam", icon: Webcam, check: "Check Windows camera access and close other software using the laptop webcam." },
  Controller: { label: "PS4 DualShock 4", icon: Gamepad2, check: "Check the configured connection and confirm that Windows recognizes the selected controller. Release the D-pad while reconnecting." },
  AI: { label: "Local matching service", icon: ScanSearch, check: "Wait for the local matching service to initialize. If it remains unavailable, check the local service and model installation." },
  Workspace: { label: "Search workspace", icon: PanelsTopLeft, check: "Return to the search workspace and keep it usable, visible and focused." },
  QualificationProfile: { label: "Qualification profile", icon: ShieldCheck, check: "Check that the active profile is compatible with this app and the configured device paths." },
} satisfies Record<ComponentName, { label: string; icon: typeof Server; check: string }>;

const causes: Partial<Record<ErrorCode, string>> = {
  INITIALIZING: "This path is still being initialized.",
  STORAGE_UNAVAILABLE: "Managed storage is unavailable.",
  PROTOCOL_UNSUPPORTED: "The configured protocol is unsupported.",
  CAPABILITY_INVALID: "The application connection could not be verified.",
  CLIENT_INVALID: "The application connection could not be verified.",
};
const tones = { Ready: "success", Initializing: "warning", Unavailable: "danger" } as const;
const recordedSearchChecks: Partial<Record<ComponentName, string>> = {
  Command: "Check the simulated command sink and local backend diagnostics.",
  RobotVideo: "Check that the configured robot recording is valid and readable, then restart the disarmed backend.",
  Webcam: "Check the selected Windows webcam, camera access, and the local Hand Landmarker installation.",
  Controller: "Connect the configured DualShock 4 by USB and check that Windows recognizes it.",
};

export function pathCheck(component: ComponentName, integrated = false) {
  return (integrated && recordedSearchChecks[component]) || paths[component].check;
}

export function localMatchingBlocker(observation: Component) {
  if (observation.status === "Initializing") return "Offline YOLOE is initializing.";
  if (observation.cause_codes.includes("MEDIA_UNAVAILABLE")) return "Check the local YOLOE checkpoint or saved reference.";
  if (observation.cause_codes.includes("PROTOCOL_UNSUPPORTED")) return "Check the pinned YOLOE runtime and worker protocol.";
  return "Offline YOLOE is unavailable. Check the backend diagnostics.";
}

export function PathRow({ observation, localMatching, integrated }: {
  observation: Component;
  localMatching?: boolean;
  integrated?: boolean;
}) {
  const { component, status, cause_codes } = observation;
  const { label, icon: Icon } = paths[component];
  const explanations = new Set(cause_codes.map((code) => causes[code]).filter(Boolean));
  return (
    <li>
      <details>
        <summary>
          <span className={styles.pathName}><Icon size={18} aria-hidden="true" />{label}</span>
          <StatusBadge tone={tones[status]}>{status}</StatusBadge>
        </summary>
        <div className={styles.troubleshooting}>
          {localMatching && component === "AI" && status !== "Ready"
            ? <p>{localMatchingBlocker(observation)}</p>
            : [...explanations].map((explanation) => <p key={explanation}>{explanation}</p>)}
          <p>{pathCheck(component, integrated)}</p>
        </div>
      </details>
    </li>
  );
}

export function InactiveInput({ input }: { input: Component }) {
  const { label, icon: Icon } = paths[input.component];
  return (
    <Panel className={styles.sideCard}>
      <div className={styles.cardTitle}>
        <h3><Icon size={20} aria-hidden="true" />{label}</h3>
        <StatusBadge>{input.status}</StatusBadge>
      </div>
      <p>Only the selected input is required.</p>
    </Panel>
  );
}

export function ProximityAdvisory({ reading }: { reading?: Proximity }) {
  const state = reading?.state;
  const label = state === "Clear" ? "Clear" : state === "Warning" ? "Warning" : state === "Unknown" ? "Unknown" : "Unavailable";
  return (
    <section aria-labelledby="proximity-title">
      <h2 id="proximity-title">Advisory only</h2>
      <Panel className={styles.sideCard}>
        <div className={styles.cardTitle}>
          <h3><Radar size={20} aria-hidden="true" />Proximity sensor</h3>
          <StatusBadge tone={state === "Clear" ? "success" : "warning"}>{label}</StatusBadge>
        </div>
        {state === "Clear" && <p>The sensor reported a valid clear reading.</p>}
        {state === "Warning" && <p>The sensor reported a nearby obstacle.</p>}
        {state === "Unknown" && <p>No valid current reading. Check sensor availability.</p>}
        {!state && <p>Proximity feedback is unavailable.</p>}
        {state === "Unknown" && reading?.warning_latched && <p>The previous warning remains active until a valid clear reading.</p>}
      </Panel>
      <p className={styles.muted}>Proximity feedback is for the operator’s awareness only.</p>
    </section>
  );
}
