import type { FrameMetadata, FrontendProfile } from "@/generated/api-v1";
import { compatibleProfile } from "../fixture-contracts";
import { parseFrameEnvelope } from "../frame-display";
import { imageHeight, imageWidth, sampleImage } from "./images";

// The catalogue verifies the exact synthetic byte vector separately from live decode.
const fixtureJpeg = sampleImage("image/jpeg");

export function parseFrame(message: Uint8Array, profile: FrontendProfile | null, source: FrameMetadata["source"]) {
  const frame = compatibleProfile(profile) && parseFrameEnvelope(message, profile, source);
  if (!frame) return null;
  const { metadata, jpeg } = frame;
  if (metadata.width !== imageWidth || metadata.height !== imageHeight ||
      jpeg.length !== fixtureJpeg.length || !fixtureJpeg.every((byte, index) => jpeg[index] === byte)) return null;
  return { metadata, jpeg };
}
