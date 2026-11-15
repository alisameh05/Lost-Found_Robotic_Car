import { useEffect, useRef, useState } from "react";
import { useProtectedRead, useRuntime, useRuntimeView, type RuntimeProjection } from "@/features/runtime";
import type { RetentionChange, RetentionPreview, Settings } from "@/generated/api-v1";

type Message = { tone: "info" | "success" | "warning" | "danger"; title: string; detail: string };
type Action = { body: RetentionChange; previous: Settings };
const settingsScope = {};
const unresolved = new WeakMap<RuntimeProjection, Action>();
const uncertain: Message = { tone: "warning", title: "Save outcome unknown", detail: "Retry the same request to check whether the change was saved." };
const outdated: Message = { tone: "warning", title: "Preview outdated", detail: "Preview the current impact and confirm again." };

export function useRetention() {
  const runtime = useRuntime()?.connection?.runtime;
  const { snapshot, health, failedRead } = useRuntimeView();
  const read = useProtectedRead("GET /settings", settingsScope);
  const [draft, setDraft] = useState<string>();
  const [preview, setPreview] = useState<RetentionPreview>();
  const [expiredPreview, setExpiredPreview] = useState<string>();
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState<"preview" | "apply">();
  const [notice, setNotice] = useState<Message>();
  const [receiptSettings, setReceiptSettings] = useState<Settings>();
  const request = useRef<{ controller: AbortController; kind: "preview" | "apply" }>(undefined);
  useEffect(() => () => request.current?.controller.abort(), []);

  const held = runtime && unresolved.get(runtime);
  const current = read.result?.kind === "ok" ? read.result.data : undefined;
  const saved = held?.previous ?? (receiptSettings && (!current || current.revision < receiptSettings.revision) ? receiptSettings : current);
  const value = draft ?? (held ? String(held.body.retention_days) : String(saved?.retention_days ?? ""));
  const days = /^\d+$/.test(value) ? Number(value) : NaN;
  const valid = Number.isInteger(days) && days >= 1 && days <= 30;
  const state = snapshot?.runtime.effective_session_state ?? snapshot?.active_session?.state ?? health?.active_session_state;
  const active = state === "Searching" || state === "Paused" ? state : undefined;
  const deletion = snapshot?.retention.deletion;
  const storageBlocked = deletion?.status === "Failed" || (health && health.storage_integrity !== "Healthy") ||
    snapshot?.readiness.components.some(({ component, status }) => component === "Storage" && status !== "Ready");
  const blocked = Boolean(active || storageBlocked || failedRead || !snapshot || !saved);
  const serverTime = runtime?.serverTime();
  const stale = preview && (expiredPreview === preview.preview_id || preview.settings_revision !== saved?.revision ||
    preview.settings_revision !== snapshot?.retention.settings.revision ||
    (serverTime !== undefined && serverTime >= preview.expires_at_ms));
  const ready = stale ? undefined : preview;

  useEffect(() => {
    if (!runtime || !preview) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const now = runtime.serverTime();
      if (now === undefined) return;
      const remaining = preview.expires_at_ms - now;
      if (remaining <= 0) setExpiredPreview(preview.preview_id);
      else timer = setTimeout(check, remaining);
    };
    timer = setTimeout(check, Math.max(0, preview.expires_at_ms - (serverTime ?? preview.evaluated_at_ms)));
    return () => clearTimeout(timer);
  }, [preview, runtime, serverTime]);

  function setValue(next: string | undefined, cancel = false) {
    if (held || request.current?.kind === "apply") return;
    request.current?.controller.abort();
    request.current = undefined;
    setBusy(undefined);
    setDraft(next);
    setNotice(preview && !cancel ? outdated : undefined);
    setPreview(undefined);
    setReviewing(false);
  }

  function start(kind: "preview" | "apply") {
    const controller = new AbortController();
    request.current = { kind, controller };
    setBusy(kind);
    setNotice(undefined);
    return controller;
  }

  function finish(controller: AbortController) {
    if (request.current?.controller !== controller) return;
    request.current = undefined;
    if (!controller.signal.aborted) setBusy(undefined);
  }

  function fail(title: string, code?: string, detail?: string) {
    setPreview(undefined);
    setReviewing(false);
    if (code === "PREVIEW_STALE" || code === "REVISION_CONFLICT") setNotice(outdated);
    else setNotice({ tone: "danger", title, detail: detail ?? "The request could not be completed. Try again." });
    if (code === "REVISION_CONFLICT" || code === "PREVIEW_STALE" || code === "ACTIVE_SESSION_EXISTS" || code === "STORAGE_UNAVAILABLE") {
      void runtime?.refresh();
    }
  }

  async function previewChange() {
    if (!runtime || !saved || !valid || blocked || held || request.current) return;
    const controller = start("preview");
    setPreview(undefined);
    setReviewing(false);
    try {
      const result = await runtime.previewRetention({ expected_revision: saved.revision, retention_days: days },
        AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]));
      if (controller.signal.aborted) return;
      if (result.kind === "ok" && result.data.settings_revision === saved.revision && result.data.retention_days === days) {
        setPreview(result.data);
      } else if (result.kind === "api-error") fail("Preview failed", result.error.code, result.error.message);
      else fail("Preview failed");
    } catch {
      if (!controller.signal.aborted) fail("Preview failed");
    } finally { finish(controller); }
  }

  async function apply(action: Action) {
    if (!runtime || request.current) return;
    unresolved.set(runtime, action);
    const controller = start("apply");
    setReviewing(false);
    setPreview(undefined);
    try {
      const result = await runtime.applyRetention(action.body, AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]));
      if (controller.signal.aborted) return;
      if (result.kind === "api-error" && (!result.error.action_id || result.error.action_id === action.body.action_id)) {
        unresolved.delete(runtime);
        fail("Retention save failed", result.error.code, result.error.message);
      } else if (result.kind === "ok" && result.data.action_id === action.body.action_id) {
        const { persistence, error, result: applied } = result.data;
        if (persistence === "Pending") {
          setNotice({ tone: "info", title: "Retention save pending", detail: "Check the same request for its committed outcome." });
        } else if (persistence === "Failed" && error) {
          unresolved.delete(runtime);
          fail("Retention save failed", error.code, error.message);
        } else if (persistence === "Committed" && applied?.settings?.retention_days === action.body.retention_days) {
          unresolved.delete(runtime);
          setDraft(undefined);
          setReceiptSettings(applied.settings);
          setNotice({ tone: "success", title: "Retention saved", detail: "See deletion progress for the remaining cleanup." });
          void runtime.refresh();
        } else setNotice(uncertain);
      } else setNotice(uncertain);
    } catch {
      if (!controller.signal.aborted) setNotice(uncertain);
    } finally { finish(controller); }
  }

  return {
    read, saved, value, valid, ready, active, blocked, storageBlocked, deletion, busy, held,
    reviewing: reviewing && Boolean(ready) && !blocked,
    notice: stale ? outdated : notice ?? (held && !busy ? uncertain : undefined),
    setValue, previewChange,
    review: () => setReviewing(true),
    closeReview: () => setReviewing(false),
    cancel: () => setValue(undefined, true),
    confirm() {
      if (!saved || !ready || !runtime || blocked || held || !reviewing) return;
      if ((runtime.serverTime() ?? ready.expires_at_ms) >= ready.expires_at_ms) { setExpiredPreview(ready.preview_id); return; }
      void apply({ previous: saved, body: { action_id: crypto.randomUUID(), expected_revision: ready.settings_revision,
        retention_days: ready.retention_days, preview_id: ready.preview_id, confirmed: true } });
    },
    retrySave() { if (held) void apply(held); },
  };
}
