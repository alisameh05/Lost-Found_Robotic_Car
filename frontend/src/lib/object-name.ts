import { unassignedInUnicode14 } from "./unicode-14-unassigned";

export const maxObjectNameLength = 120;

export function normalizeObjectName(name: string) {
  const trimmed = name.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  // NFC is stable for assigned characters. Unicode 14 treats unassigned characters
  // as inert boundaries, even if a newer browser recognizes them as combining marks.
  return trimmed.split(unassignedInUnicode14).map((part, index) => index % 2 === 0 ? part.normalize("NFC") : part).join("");
}

export function isValidObjectName(name: string) {
  return name.length > 0 && !name.includes("\0") && [...name].length <= maxObjectNameLength;
}
