import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";

const source = new URL("../../docs/API.md", import.meta.url);
const document = (await readFile(source, "utf8")).replaceAll("\r\n", "\n");
const version = document.match(/^version: "([^"]+)"/m)?.[1];
const section = document.match(/## 7\. JSON Schemas\n[\s\S]*?```json\n([\s\S]*?)\n```/)?.[1];
if (!version || !section) throw new Error("Could not extract the API version and public JSON Schema.");
const schema = JSON.parse(section);

const paths = ["/bootstrap", "/snapshot", "/objects", "/objects/{id}", "/objects/{id}/sessions", "/sessions/{id}"];
const endpoints = Object.fromEntries(paths.map((path) => {
  const row = document.split("\n").find((line) => line.startsWith(`| \`GET ${path}\` |`));
  const response = row?.match(/`200 (\w+)`/)?.[1];
  if (!response) throw new Error(`Could not extract the response definition for GET ${path}.`);
  return [path, response];
}));

const definitions = {};
function include(name) {
  if (Object.hasOwn(definitions, name)) return;
  const definition = schema.$defs[name];
  if (!definition) throw new Error(`Missing public definition ${name}.`);
  definitions[name] = definition;
  for (const match of JSON.stringify(definition).matchAll(/"#\/\$defs\/(\w+)"/g)) include(match[1]);
}
for (const name of [...Object.values(endpoints), "Error"]) include(name);

const provenance = {
  path: "docs/API.md",
  version,
  sha256: createHash("sha256").update(document).digest("hex"),
};
const seed = { $schema: schema.$schema, $comment: JSON.stringify(provenance), $defs: definitions };
const bannerComment = `// Generated from ${provenance.path} v${version} (SHA-256 ${provenance.sha256}). Do not edit.`;
// TypeScript uses the closed structural shape. Ajv checks cross-field constraints
// (such as the timestamps required by each session state) from the full seed.
const typeDefinitions = Object.fromEntries(Object.entries(definitions).map(([name, definition]) => {
  const shape = { ...definition };
  delete shape.allOf;
  delete shape.oneOf;
  return [name, shape];
}));
const types = await compile({ ...seed, $defs: typeDefinitions, type: "object", additionalProperties: false, properties: Object.fromEntries(
  Object.entries(endpoints).map(([path, name]) => [path, { $ref: `#/$defs/${name}` }]),
), required: paths }, "GetResponses", { bannerComment, unreachableDefinitions: true, ignoreMinAndMaxItems: true });
const directory = new URL("../src/generated/", import.meta.url);
const outputs = {
  "api-v1.seed.json": JSON.stringify(seed, null, 2) + "\n",
  "api-v1.ts": types.trimEnd() + "\n",
};

if (!process.argv.includes("--check")) await mkdir(directory, { recursive: true });
for (const [name, content] of Object.entries(outputs)) {
  const output = new URL(name, directory);
  if (process.argv.includes("--check")) {
    const current = await readFile(output, "utf8").catch(() => "");
    if (current.replaceAll("\r\n", "\n") !== content) {
      console.error(`${name} is stale. Run npm run contracts:generate.`);
      process.exitCode = 1;
    }
  } else {
    await writeFile(output, content);
  }
}
