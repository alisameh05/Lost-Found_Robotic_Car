import type { FrameMetadata, FrontendProfile } from "@/generated/api-v1";
import { compatibleProfile, conforms } from "../fixture-contracts";
import { imageHeight, imageWidth, sampleImage } from "./images";

// Phase 01 admits the exact synthetic JPEG used in this catalogue. The
// production frame path will need a full decoder for arbitrary JPEG payloads.
const fixtureJpeg = sampleImage("image/jpeg");

export function parseFrame(message: Uint8Array, profile: FrontendProfile | null, source: FrameMetadata["source"]) {
  if (!compatibleProfile(profile) || message.byteLength < 5 || message.byteLength > profile.max_frame_bytes) return null;
  const headerLength = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(0);
  if (headerLength === 0 || headerLength > profile.max_header_bytes || headerLength >= message.length - 4) return null;

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
  if (metadata.width !== imageWidth || metadata.height !== imageHeight ||
      jpeg.length !== fixtureJpeg.length || !fixtureJpeg.every((byte, index) => jpeg[index] === byte)) return null;
  return { metadata, jpeg };
}
