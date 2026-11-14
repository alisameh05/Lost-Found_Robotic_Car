export const maxObjectNameLength = 120;

export function normalizeObjectName(name: string) {
  return name.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "").normalize("NFC");
}
