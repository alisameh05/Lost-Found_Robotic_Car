import { expect, test, vi } from "vitest";
import { openFrameDisplay, parseFrameEnvelope } from "../frame-display";
import { fixtureProfile, sampleTime } from "./samples";
import { encodeFrame, frameVector, invalidFrameVectors } from "./vectors";

const sample = frameVector("robot", fixtureProfile)!;
const { metadata, jpeg } = parseFrameEnvelope(sample, fixtureProfile, "robot")!;
const frame = (sequence: number) => encodeFrame({ ...metadata, capture_seq: sequence,
  frame_id: `sample-robot-${sequence}`, source_capture_us: sequence * 1000 }, jpeg);

test("checks envelope and JPEG dimensions before decode and exact dimensions after decode", async () => {
  const present = vi.fn(() => true);
  const wrongSize = { width: 1, height: metadata.height, close: vi.fn() };
  const decode = vi.fn(async () => wrongSize);
  const display = openFrameDisplay({ profile: fixtureProfile, source: "robot", serverTime: () => sampleTime,
    monotonic: () => 0, decode, present, changed() {}, epochChanged() {} });
  const { oversizedMessage, oversizedDimensions, malformedUtf8, duplicateKey, mismatchedDimensions, corruptJpeg } = invalidFrameVectors();
  for (const invalid of [oversizedMessage, oversizedDimensions, malformedUtf8, duplicateKey, mismatchedDimensions, corruptJpeg,
    frameVector("webcam", fixtureProfile)!]) display.receive(invalid);
  expect(decode).not.toHaveBeenCalled();
  display.receive(sample);
  await Promise.resolve();
  expect(wrongSize.close).toHaveBeenCalledOnce();
  expect(present).not.toHaveBeenCalled();
  expect(display.displayedFrame()).toBeNull();
  display.reset();
});

test("acknowledges the latest successfully drawn image and rejects duplicate acquisition freshness", async () => {
  let clock = 0;
  const decoded = () => ({ width: metadata.width, height: metadata.height, close: vi.fn() });
  const first = decoded();
  const second = decoded();
  const third = decoded();
  const firstDecode = Promise.withResolvers<typeof first>();
  const latestDecode = Promise.withResolvers<typeof second>();
  const decode = vi.fn().mockReturnValueOnce(firstDecode.promise).mockReturnValueOnce(latestDecode.promise).mockResolvedValueOnce(third);
  const present = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
  const display = openFrameDisplay({ profile: fixtureProfile, source: "robot", serverTime: () => sampleTime + clock,
    monotonic: () => clock, decode, present, changed() {}, epochChanged() {} });
  display.receive(frame(1));
  display.receive(frame(2));
  display.receive(frame(3));
  expect(decode).toHaveBeenCalledOnce();
  expect(display.displayedFrame()).toBeNull();
  firstDecode.resolve(first);
  await Promise.resolve();
  await Promise.resolve();
  expect(first.close).toHaveBeenCalledOnce();
  expect(present).toHaveBeenCalledExactlyOnceWith(first);
  expect(display.displayedFrame()).toBeNull();
  latestDecode.resolve(second);
  await Promise.resolve();
  expect(display.displayedFrame()).toEqual({ frame_id: "sample-robot-3", stream_epoch: metadata.stream_epoch });
  display.receive(frame(4));
  await Promise.resolve();
  expect(present).toHaveBeenLastCalledWith(third);
  expect(display.displayedFrame()).toEqual({ frame_id: "sample-robot-4", stream_epoch: metadata.stream_epoch });
  clock += fixtureProfile.capture_age_limit_ms;
  display.receive(frame(4));
  expect(display.displayedFrame()).toBeNull();
  expect(decode).toHaveBeenCalledTimes(3);
  display.reset();
});
