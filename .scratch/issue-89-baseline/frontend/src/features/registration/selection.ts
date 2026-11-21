import type { Rect } from "@/generated/api-v1";

export type Size = Pick<Rect, "width" | "height">;
export type Point = Pick<Rect, "x" | "y">;
export const coordinates = ["x", "y", "width", "height"] as const;
export type SelectionFields = Record<keyof Rect, string>;
export const emptySelection: SelectionFields = { x: "", y: "", width: "", height: "" };

export function selectionFields(rect: Rect): SelectionFields {
  return { x: String(rect.x), y: String(rect.y), width: String(rect.width), height: String(rect.height) };
}

export function readSelection(fields: SelectionFields, size: Size) {
  const values = { x: Number(fields.x), y: Number(fields.y), width: Number(fields.width), height: Number(fields.height) };
  const errors: Partial<SelectionFields> = {};
  for (const key of coordinates) {
    const minimum = key === "x" || key === "y" ? 0 : 1;
    if (!/^[0-9]+$/.test(fields[key]) || !Number.isSafeInteger(values[key]) || values[key] < minimum) {
      errors[key] = `Enter a whole number of at least ${minimum}.`;
    }
  }
  if (!errors.x && values.x >= size.width) errors.x = "X must be inside the image.";
  if (!errors.y && values.y >= size.height) errors.y = "Y must be inside the image.";
  if (!errors.width && !errors.x && values.width > size.width - values.x) errors.width = "Width extends past the image.";
  if (!errors.height && !errors.y && values.height > size.height - values.y) errors.height = "Height extends past the image.";
  return { rect: Object.keys(errors).length ? null : values, errors };
}

export function pixelPoint(bounds: Size & { left: number; top: number }, image: Size,
  clientX: number, clientY: number, clamp = false): Point | null {
  const scale = Math.min(bounds.width / image.width, bounds.height / image.height);
  if (scale <= 0) return null;
  const x = (clientX - bounds.left - (bounds.width - image.width * scale) / 2) / scale;
  const y = (clientY - bounds.top - (bounds.height - image.height * scale) / 2) / scale;
  if (!clamp && (x < 0 || y < 0 || x > image.width || y > image.height)) return null;
  return {
    x: Math.round(Math.min(image.width, Math.max(0, x))),
    y: Math.round(Math.min(image.height, Math.max(0, y))),
  };
}

export function dragRect(start: Point, end: Point): Rect {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) };
}
