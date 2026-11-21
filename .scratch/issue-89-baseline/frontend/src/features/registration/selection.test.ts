import { expect, test } from "vitest";
import { dragRect, pixelPoint, readSelection } from "./selection";

test("reverse pointer drag within a letterboxed image agrees with keyboard pixel fields", () => {
  const image = { width: 100, height: 50 };
  const bounds = { left: 10, top: 20, width: 400, height: 400 };
  expect(pixelPoint(bounds, image, 30, 80)).toBeNull();
  const start = pixelPoint(bounds, image, 410, 320)!;
  const end = pixelPoint(bounds, image, 50, 160)!;
  const keyboard = readSelection({ x: "10", y: "10", width: "90", height: "40" }, image);
  expect(dragRect(start, end)).toEqual({ x: 10, y: 10, width: 90, height: 40 });
  expect(keyboard.rect).toEqual(dragRect(start, end));
  expect(readSelection({ x: "10", y: "10", width: "91", height: "40" }, image).rect).toBeNull();
  expect(readSelection({ x: "0.5", y: "10", width: "90", height: "40" }, image).rect).toBeNull();
});
