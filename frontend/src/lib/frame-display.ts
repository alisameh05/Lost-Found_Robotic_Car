import type { FrameMetadata, FrontendProfile } from "@/generated/api-v1";
import { conforms } from "./fixture-contracts";

type Source = FrameMetadata["source"];
type Frame = { metadata: FrameMetadata; jpeg: Uint8Array<ArrayBuffer> };

// Read the JPEG size before giving the compressed payload to the browser decoder.
function jpegMatches(bytes: Uint8Array, { width, height }: FrameMetadata) {
  const length = bytes.byteLength;
  if (length < 10 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[length - 2] !== 255 || bytes[length - 1] !== 217) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  let offset = 2;
  let dimensionsSeen = false;
  while (offset < length - 2) {
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (!marker || marker === 216 || marker === 217 || (marker >= 208 && marker <= 215) || offset + 2 > length) return false;
    const size = view.getUint16(offset);
    const end = offset + size;
    if (size < 2 || end > length - 2) return false;
    if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
      if (dimensionsSeen || size < 8 || view.getUint16(offset + 3) !== height || view.getUint16(offset + 5) !== width) return false;
      dimensionsSeen = true;
    }
    if (marker === 218) {
      if (!dimensionsSeen || end >= length - 2) return false;
      // Skip the scan until the next marker, honoring stuffed bytes and restart markers.
      offset = end;
      while (offset < length - 2) {
        if (bytes[offset++] !== 255) continue;
        const next = bytes[offset];
        if (next === 0 || (next >= 208 && next <= 215)) offset++;
        else { offset--; break; }
      }
      if (offset === length - 2) return true;
    } else {
      offset = end;
    }
  }
  return false;
}

export function parseFrameEnvelope(message: Uint8Array, profile: FrontendProfile, source: Source): Frame | null {
  if (message.byteLength < 5 || message.byteLength > profile.max_frame_bytes) return null;
  const headerLength = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(0);
  if (!headerLength || headerLength > profile.max_header_bytes || headerLength >= message.length - 4) return null;
  let value: unknown;
  try {
    const header = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(message.subarray(4, 4 + headerLength));
    const keys = [...header.matchAll(/("(?:[^"\\]|\\.)*")\s*:/g)].map(([, key]) => JSON.parse(key) as string);
    if (new Set(keys).size !== keys.length) return null;
    value = JSON.parse(header);
  } catch {
    return null;
  }
  if (!conforms("FrameMetadata", value)) return null;
  const metadata = value as FrameMetadata;
  if (metadata.source !== source || metadata.width > profile.max_frame_width || metadata.height > profile.max_frame_height ||
      metadata.width > Math.floor(profile.max_frame_pixels / metadata.height)) return null;
  const jpeg = message.subarray(4 + headerLength);
  return jpegMatches(jpeg, metadata) ? { metadata, jpeg: new Uint8Array(jpeg) } : null;
}

type DecodedFrame = { width: number; height: number; close(): void };
type Queued = { frame: Frame; expires: number };

export function openFrameDisplay<Image extends DecodedFrame>({
  profile, source, serverTime, monotonic, decode, present, changed, epochChanged,
}: {
  profile: FrontendProfile;
  source: Source;
  serverTime: () => number | undefined;
  monotonic: () => number;
  decode(jpeg: Uint8Array<ArrayBuffer>): Promise<Image>;
  present(image: Image): boolean;
  changed(live: boolean): void;
  epochChanged(): void;
}) {
  let lifetime = 0;
  let latest: FrameMetadata | undefined;
  let displayed: { metadata: FrameMetadata; expires: number } | undefined;
  let waiting: Queued | undefined;
  let decoding = false;
  let live = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function markLive(next: boolean) {
    if (live === next) return;
    live = next;
    changed(live);
  }

  function expire() {
    clearTimeout(timer);
    if (!displayed) return;
    const remaining = displayed.expires - monotonic();
    if (remaining <= 0) {
      displayed = undefined;
      markLive(false);
    } else {
      timer = setTimeout(expire, Math.ceil(remaining));
    }
  }

  async function drain() {
    if (decoding || !waiting) return;
    decoding = true;
    const job = waiting;
    waiting = undefined;
    const generation = lifetime;
    let image: Image | undefined;
    try {
      image = await decode(job.frame.jpeg);
      const { width, height } = job.frame.metadata;
      if (generation !== lifetime || monotonic() >= job.expires ||
          image.width !== width || image.height !== height || !present(image)) return;
      displayed = { metadata: job.frame.metadata, expires: job.expires };
      expire();
      if (displayed) markLive(true);
    } catch {
      // An invalid decode or draw never replaces the currently acknowledged image.
    } finally {
      image?.close();
      decoding = false;
      void drain();
    }
  }

  return {
    receive(message: Uint8Array) {
      const received = monotonic();
      if (message.byteLength > profile.max_frame_bytes) return;
      const frame = parseFrameEnvelope(message, profile, source);
      if (!frame) return;
      const { metadata } = frame;
      if (latest && (latest.stream_epoch !== metadata.stream_epoch || latest.source_clock_epoch !== metadata.source_clock_epoch)) {
        epochChanged();
        return;
      }
      if (latest && (metadata.capture_seq <= latest.capture_seq || metadata.frame_id === latest.frame_id ||
        metadata.source_capture_us <= latest.source_capture_us)) return;
      latest = metadata;
      const time = serverTime();
      if (time === undefined || metadata.received_at_ms > time) return;
      const age = metadata.capture_age_bound_ms + time - metadata.received_at_ms;
      const expires = received + Math.min(profile.capture_age_limit_ms, profile.display_deadline_ms) - age;
      if (expires <= monotonic()) return;
      waiting = { frame, expires };
      void drain();
    },
    displayedFrame() {
      expire();
      const metadata = displayed?.metadata;
      return metadata ? { frame_id: metadata.frame_id, stream_epoch: metadata.stream_epoch } : null;
    },
    reset() {
      lifetime++;
      latest = undefined;
      waiting = undefined;
      displayed = undefined;
      clearTimeout(timer);
      markLive(false);
    },
  };
}
