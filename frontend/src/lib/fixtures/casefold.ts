import caseFoldMappings from "./casefold-data.json";

const mappings: Readonly<Record<string, string>> = caseFoldMappings;

// Unicode 17.0.0 CaseFolding.txt, common and full mappings (C and F).
export function caseFold(text: string) {
  return Array.from(text, (character) => mappings[character] ?? character).join("");
}
