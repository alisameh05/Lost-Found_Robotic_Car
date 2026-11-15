import { useId } from "react";
import type { ControlMode } from "@/generated/api-v1";
import layout from "@/components/layout/support-page.module.css";
import styles from "./control-guide.module.css";

const instructions = {
  Gestures: {
    title: "Gesture directions and stop",
    direction: "In the mirrored webcam view, hold one extended index finger pointing up for forward, down for backward, left for left, or right for right.",
    stop: "Release the pointing gesture to stop. A closed fist, no hand, multiple hands, or ambiguous or invalid pointing stops ordinary movement.",
  },
  Controller: {
    title: "PS4 controller",
    direction: "On the DualShock 4, hold D-pad up for forward, down for backward, left for left, or right for right. Release the D-pad to stop. Conflicting directions also stop ordinary movement.",
    stop: "Press Circle for Emergency Stop. The UI Emergency Stop works in either mode. Gesture input is inactive in Controller mode.",
  },
} satisfies Record<ControlMode, { title: string; direction: string; stop: string }>;

export function ModeInstructions({ mode, heading: Heading = "h2", title }: {
  mode: ControlMode; heading?: "h2" | "h3"; title?: string;
}) {
  const id = useId();
  const content = instructions[mode];
  return <section className={styles.rule} aria-labelledby={id}>
    <Heading id={id}>{title ?? content.title}</Heading>
    <p>{content.direction}</p>
    <p>{content.stop}</p>
  </section>;
}

export function ControlGuideContent({ heading: Heading = "h2" }: { heading?: "h2" | "h3" }) {
  const id = useId();
  return (
    <div className={`${layout.columns} ${styles.content}`}>
      <div>
        <ModeInstructions mode="Gestures" heading={Heading} />
        <ModeInstructions mode="Controller" heading={Heading} />
        <section className={styles.rule} aria-labelledby={`${id}-session`}>
          <Heading id={`${id}-session`}>Pause, Stop Search and Emergency Stop</Heading>
          <dl className={styles.actions}>
            <div><dt>Pause</dt><dd>Stops motion and matching while keeping the session active.</dd></div>
            <div><dt>Stop Search</dt><dd>Stops motion and matching and ends the session.</dd></div>
            <div><dt>Emergency Stop</dt><dd>Revokes motion permission immediately and pauses the session with recovery required.</dd></div>
          </dl>
        </section>
      </div>
      <section className={styles.recovery} aria-labelledby={`${id}-recovery`}>
        <Heading id={`${id}-recovery`}>Match review and recovery</Heading>
        <p>A potential match pauses the session. Confirm saves the evidence, commits the object as Found,
          and ends the session. Reject keeps the object Lost and the session Paused until you explicitly select Resume.</p>
        <p>After Emergency Stop or a required-path failure, follow these steps in the search workspace.</p>
        <ol>
          <li>Restore every required path.</li>
          <li>Acknowledge each restored cause.</li>
          <li>Select Resume explicitly.</li>
          <li>Release input to neutral, then apply a fresh hold.</li>
        </ol>
      </section>
    </div>
  );
}
