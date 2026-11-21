import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useProtectedRead, useRuntime, useRuntimeView, type RuntimeProjection } from "@/features/runtime";
import type { Operation, RetentionChange, RetentionPreview, Settings } from "@/generated/api-v1";

type Message = { tone: "info" | "success" | "warning" | "danger"; title: string; detail: string };
type PendingSave = { boot?: string; afterPoll: number };
type Action = { body: RetentionChange; previous: Settings; pending?: PendingSave };
const settingsScope = {};
const unresolved = new WeakMap<RuntimeProjection, Action>();
const uncertain: Message = { tone: "warning", title: "Save outcome unknown", detail: "Retry the same request to check whether the change was saved." };
const pendingSave: Message = { tone: "info", title: "Retention save pending", detail: "Waiting for the local backend to finish saving." };
const outdated: Message = { tone: "warning", title: "Preview outdated", detail: "Preview the current impact and confirm again." };

export function useRetention() {
  const runtime = useRuntime()?.connection?.runtime;
  const { snapshot, recordSnapshot, recordPoll, recordsMode, health, failedRead, cursorAuthority } = useRuntimeView();
  const read = useProtectedRead("GET /settings", settingsScope);
  const [draft, setDraft] = useState<string>();
  const [previewState, setPreview] = useState<{ data: RetentionPreview; authority: typeof cursorAuthority }>();
  const preview = previewState?.data;
  const [expiredPreview, setExpiredPreview] = useState<string>();
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState<"preview" | "apply">();
  const [notice, setNotice] = useState<Message>();
  const [receipt, setReceipt] = useState<{ settings: Settings; authority: typeof cursorAuthority }>();
  const request = useRef<{ controller: AbortController; kind: "preview" | "apply" }>(undefined);
  useEffect(() => () => request.current?.controller.abort(), []);

  const held = runtime && unresolved.get(runtime);
  const acceptance = held?.pending;
  const fetched = read.result?.kind === "ok" ? read.result.data : undefined;
  const projected = recordsMode ? recordSnapshot?.retention.settings : undefined;
  const current = projected && (!fetched || projected.revision >= fetched.revision) ? projected : fetched;
  const receiptSettings = receipt?.authority === cursorAuthority ? receipt?.settings : undefined;
  const latest = receiptSettings && (!current || current.revision < receiptSettings.revision) ? receiptSettings : current;
  const saved = recordsMode ? latest ?? held?.previous : held?.previous ?? latest;
  const value = draft ?? (held ? String(held.body.retention_days) : String(saved?.retention_days ?? ""));
  const days = /^\d+$/.test(value) ? Number(value) : NaN;
  const valid = Number.isInteger(days) && days >= 1 && days <= 30;
  const state = snapshot?.runtime.effective_session_state ?? snapshot?.active_session?.state ?? health?.active_session_state;
  const active = state === "Searching" || state === "Paused" ? state : undefined;
  const deletion = (snapshot ?? recordSnapshot)?.retention.deletion;
  const storageBlocked = deletion?.status === "Failed" || (health && health.storage_integrity !== "Healthy") ||
    snapshot?.readiness.components.some(({ component, status }) => component === "Storage" && status !== "Ready");
  const blocked = Boolean(active || storageBlocked || failedRead || !snapshot || !saved);
  const serverTime = runtime?.serverTime();
  const stale = preview && (previewState.authority !== cursorAuthority ||
    expiredPreview === preview.preview_id || preview.settings_revision !== saved?.revision ||
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

  function savedAction(action: Action, settings: Settings) {
    if (!runtime || unresolved.get(runtime) !== action) return;
    unresolved.delete(runtime);
    setDraft(undefined);
    setReceipt({ settings, authority: cursorAuthority });
    setNotice({ tone: "success", title: "Retention saved", detail: "See deletion progress for the remaining cleanup." });
  }

  function failedAction(action: Action, code: string, message: string) {
    if (!runtime || unresolved.get(runtime) !== action) return;
    unresolved.delete(runtime);
    fail("Retention save failed", code, message);
  }

  const settlePending = useEffectEvent((action: Action, operation: Operation | undefined) => {
    if (request.current?.kind === "apply") return;
    if (!operation) {
      action.pending = undefined;
      setNotice(uncertain);
      return;
    }
    const settings = operation.result?.settings;
    if (operation.persistence === "Committed" && settings?.retention_days === action.body.retention_days) {
      savedAction(action, settings);
    } else if (operation.persistence === "Failed" && operation.error) {
      failedAction(action, operation.error.code, operation.error.message);
    }
  });

  useEffect(() => {
    const observed = snapshot ?? recordSnapshot;
    if (!held || !acceptance || busy || !observed) return;
    const restarted = acceptance.boot !== undefined && acceptance.boot !== observed.backend_boot_id;
    const terminal = (recordPoll ?? 0) > acceptance.afterPoll && observed.operations.find(({ action_id, persistence }) =>
      action_id === held.body.action_id && persistence !== "Pending");
    if (!terminal && !restarted) return;
    let current = true;
    queueMicrotask(() => {
      if (current && held.pending === acceptance) settlePending(held, restarted ? undefined : terminal || undefined);
    });
    return () => { current = false; };
  }, [acceptance, busy, held, recordPoll, recordSnapshot, snapshot]);

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
        setPreview({ data: result.data, authority: cursorAuthority });
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
      if (result.kind === "api-error" && (result.error.code === "CAPABILITY_INVALID" || result.error.code === "CLIENT_INVALID" ||
          result.error.code === "INTERNAL_ERROR" || (recordsMode && result.status >= 500))) {
        setNotice(uncertain);
      } else if (result.kind === "api-error" && (!result.error.action_id || result.error.action_id === action.body.action_id)) {
        failedAction(action, result.error.code, result.error.message);
      } else if (result.kind === "ok" && result.data.action_id === action.body.action_id) {
        const { persistence, error, result: applied } = result.data;
        if (persistence === "Pending") {
          if (recordsMode) {
            const view = runtime.getView();
            action.pending = {
              boot: view.snapshot?.backend_boot_id ?? view.recordSnapshot?.backend_boot_id ?? view.health?.backend_boot_id,
              afterPoll: view.recordPoll ?? 0,
            };
            // Cancel any snapshot started before this attempt was acknowledged.
            void runtime.refresh();
          }
          setNotice(pendingSave);
        } else if (persistence === "Failed" && error) {
          failedAction(action, error.code, error.message);
        } else if (persistence === "Committed" && applied?.settings?.retention_days === action.body.retention_days) {
          savedAction(action, applied.settings);
          if (!recordsMode) void runtime.refresh();
        } else setNotice(uncertain);
      } else setNotice(uncertain);
    } catch {
      if (!controller.signal.aborted) setNotice(uncertain);
    } finally { finish(controller); }
  }

  return {
    read, saved, value, valid, ready, active, blocked, storageBlocked, deletion, busy, held,
    reviewing: reviewing && Boolean(ready) && !blocked,
    notice: stale ? outdated : notice ?? (held && !busy ? acceptance ? pendingSave : uncertain : undefined),
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
