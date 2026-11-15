export const maxReferenceBytes = 10_485_760;
export const maxReferencePixels = 20_000_000;
export type ReferenceContentType = "image/jpeg" | "image/png";
export type ImageDimensions = { width: number; height: number };
export type NormalizedReference = ImageDimensions & { blob: Blob };
export type ReferenceDecodeRequest = { source: Blob; preview: boolean };
export type ReferenceDecodeResponse =
  | { image: NormalizedReference } | { error: string; status: 413 | 422 };

export class ReferenceImageError extends Error {
  constructor(message: string, readonly status: 413 | 422) { super(message); }
}
