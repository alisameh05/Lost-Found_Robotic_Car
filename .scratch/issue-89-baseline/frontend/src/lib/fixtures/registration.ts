import type { Error as ApiError, MutationResponse, Object as LostObject, Operation, Snapshot } from "@/generated/api-v1";
import { conforms } from "../fixture-contracts";
import { isValidObjectName, normalizeObjectName } from "../object-name";
import { maxReferenceBytes, normalizeReference, ReferenceImageError, type NormalizedReference } from "../reference-image";
import type { HttpRequest, ReadResult } from "../transport";
import { emptyResult, mutation } from "./mutations";
import { expiryFor } from "./retention";

type RegistrationRequest = Pick<HttpRequest<"POST /objects">, "body" | "actionCreatedAtMs">;
type Receipt = Extract<ReadResult<MutationResponse>, { kind: "ok" }>;
type Entry = {
  fingerprint: string;
  receipt: Receipt;
  preparation?: Promise<ReadResult<MutationResponse>>;
  deliverOnRetry?: () => Receipt;
};
type Record = { object: LostObject; bytes: Uint8Array<ArrayBuffer> };

function reject(status: number, code: ApiError["code"], message: string, path?: string): ReadResult<never> {
  return { kind: "api-error", status, error: { code, message, retryable: false,
    ...(path ? { field_errors: [{ path, code: status === 413 ? "OUT_OF_RANGE" : "INVALID_VALUE", message }] } : {}) } };
}

export function openRegistrations({ now, bootSignal, getSnapshot, healthy, isExcluded, clockHealthy, normalize = normalizeReference, recovery, scripted }: {
  now: () => number;
  bootSignal: () => AbortSignal;
  getSnapshot: () => Snapshot;
  healthy: boolean;
  isExcluded: (owner: string) => boolean;
  clockHealthy: () => boolean;
  normalize?: typeof normalizeReference;
  recovery: boolean;
  scripted?: (actionId: string, signal: AbortSignal) => Promise<"Committed" | "Failed" | undefined>;
}) {
  const entries = new Map<string, Entry>();
  const records = new Map<string, Record>();
  const completions = new Set<string>();
  let sequence = 0;
  let admitted = 0;

  function finish(entry: Entry, receipt: Receipt) {
    entry.receipt = receipt;
    const id = receipt.data.action_id;
    completions.add(id);
    if (completions.size > 64) {
      const oldest = completions.values().next().value!;
      completions.delete(oldest);
      if (entries.get(oldest)?.receipt.data.persistence === "Failed") entries.delete(oldest);
    }
    return receipt;
  }

  async function submit({ body, actionCreatedAtMs }: RegistrationRequest): Promise<ReadResult<MutationResponse>> {
    const signal = bootSignal();
    if (!body || typeof body !== "object") return reject(422, "VALIDATION_FAILED", "Registration details are required.");
    const { reference_image: image, ...fields } = body;
    if (typeof fields.name !== "string") return reject(422, "VALIDATION_FAILED", "Enter an object name.", "/name");
    const name = normalizeObjectName(fields.name);
    if (!isValidObjectName(name)) {
      return reject(422, "VALIDATION_FAILED", "Enter a name with 1 to 120 characters.", "/name");
    }
    if (!conforms("RegistrationFields", { ...fields, name }) || !Number.isSafeInteger(actionCreatedAtMs) || actionCreatedAtMs < 0) {
      return reject(422, "VALIDATION_FAILED", "Registration details are invalid.");
    }
    if (!(image instanceof Blob) || !image.size) return reject(422, "VALIDATION_FAILED", "Choose a reference image.", "/reference_image");
    if (image.size > maxReferenceBytes) return reject(413, "PAYLOAD_TOO_LARGE", "The reference image exceeds 10 MiB.", "/reference_image");
    const { action_id } = fields;
    const roi = { ...fields.roi };
    const hash = await crypto.subtle.digest("SHA-256", await image.arrayBuffer());
    const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    signal.throwIfAborted();
    const fingerprint = JSON.stringify({
      action_type: "register", expected_revision: null,
      payload: { image_sha256: digest, name, roi: { height: roi.height, width: roi.width, x: roi.x, y: roi.y },
        submitted_at_ms: actionCreatedAtMs },
      resource_id: null, scope: "Object",
    });
    const previous = entries.get(action_id);
    if (previous) {
      const object = records.get(action_id)?.object;
      const state = getSnapshot();
      if (object && (isExcluded(object.id) || (expiryFor(object.registered_at_ms, state.retention.settings.retention_days) <= now() &&
          state.active_session?.object_id !== object.id))) {
        return reject(410, "EXPIRED", "Sample record expired.");
      }
      if (previous.fingerprint !== fingerprint) return reject(409, "ACTION_ID_CONFLICT", "This action ID belongs to a different registration.");
      if (previous.preparation) return previous.preparation;
      if (previous.deliverOnRetry) {
        // The first retry loses its response after the fixture commits.
        previous.deliverOnRetry();
        previous.deliverOnRetry = undefined;
        return { kind: "unavailable" };
      }
      if (previous.receipt.data.persistence !== "Failed" || !previous.receipt.data.error?.retryable) return previous.receipt;
    }
    if (!clockHealthy()) return reject(503, "NOT_READY", "The sample clock must recover before registration can continue.");
    const age = now() - actionCreatedAtMs;
    if (!previous && (age < 0 || age > 600_000)) return reject(410, "ACTION_EXPIRED", "The registration request expired before admission.");
    const { retention } = getSnapshot();
    if (!healthy || retention.deletion.status === "Failed") {
      return reject(503, "STORAGE_UNAVAILABLE", "Sample storage is unavailable. Check Devices and try again when storage is ready.");
    }
    // Preparation reserves the ID for deduplication. Only validated admissions appear in snapshots.
    const pendingCount = [...entries.values()].filter(({ receipt }) => receipt.data.persistence === "Pending").length;
    if (pendingCount >= 62) {
      return reject(503, "CAPACITY_REACHED", "Too many registrations are pending.");
    }
    const preparation = Promise.withResolvers<ReadResult<MutationResponse>>();
    const entry: Entry = { fingerprint, receipt: mutation(action_id, "Pending", emptyResult), preparation: preparation.promise };
    completions.delete(action_id);
    entries.set(action_id, entry);
    function rejectPreparation(result: ReadResult<never>) {
      if (entries.get(action_id) === entry) entries.delete(action_id);
      preparation.resolve(result);
      signal.throwIfAborted();
      return result;
    }
    let normalized: NormalizedReference;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      normalized = await normalize(image, signal);
      const { width, height } = normalized;
      if (roi.width > width - roi.x || roi.height > height - roi.y) {
        const field = roi.width > width - roi.x ? "width" : "height";
        return rejectPreparation(reject(422, "VALIDATION_FAILED", `Selection ${field} must fit the normalized image.`, `/roi/${field}`));
      }
      bytes = new Uint8Array(await normalized.blob.arrayBuffer());
      signal.throwIfAborted();
    } catch (error) {
      return rejectPreparation(error instanceof ReferenceImageError
        ? reject(error.status, error.status === 413 ? "PAYLOAD_TOO_LARGE" : "VALIDATION_FAILED",
          error.message, "/reference_image")
        : reject(422, "VALIDATION_FAILED", "The reference image is corrupt or unreadable.", "/reference_image"));
    }
    admitted++;
    function commit() {
      signal.throwIfAborted();
      if (getSnapshot().retention.deletion.status === "Failed") return finish(entry, mutation(action_id, "Failed", emptyResult));
      const registered_at_ms = now();
      const id = `fixture-object-${String(++sequence).padStart(8, "0")}`;
      const object: LostObject = {
        id, name, status: "Lost", revision: 1, registered_at_ms, found_at_ms: null, roi,
        expires_at_ms: expiryFor(registered_at_ms, getSnapshot().retention.settings.retention_days), retention_grace: false,
        reference_media: {
          id: `${id}-reference`, role: "Reference", content_type: normalized.blob.type === "image/jpeg" ? "image/jpeg" : "image/png",
          width: normalized.width, height: normalized.height, byte_length: bytes.length, created_at_ms: registered_at_ms,
          availability: "Available",
        },
      };
      records.set(action_id, { object, bytes });
      return finish(entry, mutation(action_id, "Committed", { ...emptyResult, object }, 201, `/api/v1/objects/${id}`));
    }

    const order = admitted;
    entry.preparation = undefined;
    if (recovery && order === 1) {
      preparation.resolve(finish(entry, mutation(action_id, "Failed", emptyResult)));
    } else if (recovery && order === 2) {
      entry.deliverOnRetry = commit;
      preparation.resolve(entry.receipt);
    } else {
      const delivery = scripted?.(action_id, signal);
      if (delivery) preparation.resolve(entry.receipt);
      const outcome = await delivery;
      signal.throwIfAborted();
      preparation.resolve(outcome === "Failed" ? finish(entry, mutation(action_id, "Failed", emptyResult)) : commit());
    }
    return entry.receipt;
  }

  return {
    submit,
    records: () => [...records.values()],
    updateObject(updated: Record["object"]) {
      for (const [action, record] of records) {
        if (record.object.id === updated.id) {
          records.set(action, { ...record, object: updated });
          return;
        }
      }
    },
    purge(owners: ReadonlyMap<string, number>) {
      for (const [action, { object }] of records) {
        if (!owners.has(object.id)) continue;
        records.delete(action);
        entries.delete(action);
        completions.delete(action);
      }
    },
    operations(): Operation[] {
      const pending = [...entries].filter(([, entry]) => !entry.preparation && entry.receipt.data.persistence === "Pending");
      const visible = [...pending.map(([id]) => id), ...completions];
      return visible.map((id) => ({ ...entries.get(id)!.receipt.data, request_id: null }));
    },
    restart() {
      for (const [id, entry] of entries) if (entry.receipt.data.persistence === "Pending") entries.delete(id);
      completions.clear();
    },
    clear() { entries.clear(); records.clear(); completions.clear(); },
  };
}
