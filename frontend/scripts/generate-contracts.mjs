import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";

const source = new URL("../../docs/API.md", import.meta.url);
const document = (await readFile(source, "utf8")).replaceAll("\r\n", "\n");
const version = document.match(/^version: "([^"]+)"/m)?.[1];
const section = document.match(/## 7\. JSON Schemas\n[\s\S]*?```json\n([\s\S]*?)\n```/)?.[1];
if (!version || !section) throw new Error("Could not extract the API version and public JSON Schema.");
const schema = JSON.parse(section);
const definitions = schema.$defs;

const endpoints = [...document.matchAll(/^\| `((?:GET|POST|PUT|WS) \/[^ ]+)` \| (.*?) \| (.*?) \|$/gm)]
  .map(([, route, request, response]) => ({ route, request, response }));
if (!endpoints.length) throw new Error("Could not extract the endpoint catalogue.");

const provenance = {
  path: "docs/API.md",
  version,
  sha256: createHash("sha256").update(document).digest("hex"),
};
const seed = { ...schema, $comment: JSON.stringify({ ...provenance, endpoints }) };
const bannerComment = `// Generated from ${provenance.path} v${version} (SHA-256 ${provenance.sha256}). Do not edit.`;

// Expand object conditions into TypeScript variants while retaining the
// original Draft 2020-12 constraints in the executable seed.
function variantsFor(rule, variant) {
  const conditions = Object.entries(rule.if?.properties ?? {});
  if (!conditions.length) {
    const properties = { ...variant.properties };
    for (const [name, change] of Object.entries(rule.properties ?? {})) {
      const referenced = definitions[properties[name]?.$ref?.split("/").at(-1)];
      if (!referenced) throw new Error(`Cannot refine ${name} without a definition.`);
      properties[name] = { ...referenced, properties: { ...referenced.properties, ...change.properties } };
    }
    return [{ ...variant, properties }];
  }
  if (conditions.length !== 1) throw new Error("Unexpected compound schema condition.");
  const [[field, test]] = conditions;
  const property = variant.properties[field];
  const values = property.enum ?? (Object.hasOwn(property, "const") ? [property.const] : []);
  const accepted = test.enum ?? [test.const];
  if (!values.length) throw new Error(`Cannot generate conditional variant for ${field}.`);
  return values.map((value) => {
    const branch = accepted.includes(value) ? rule.then : rule.else;
    const properties = { ...variant.properties };
    for (const [name, change] of Object.entries(branch?.properties ?? {})) {
      if (change.$ref || change.type || Object.hasOwn(change, "const")) properties[name] = change;
      if (change.maxItems === 0) properties[name] = { type: "array", minItems: 0, maxItems: 0, items: [] };
    }
    const required = [...new Set([...(variant.required ?? []), ...(branch?.required ?? [])])];
    for (const name of branch?.not?.required ?? []) properties[name] = { tsType: "never" };
    properties[field] = { const: value };
    return { ...variant, properties, required };
  });
}

const typeDefinitions = Object.fromEntries(Object.entries(definitions).map(([name, definition]) => {
  const { allOf = [], oneOf, ...shape } = definition;
  const variants = allOf.reduce((current, rule) => current.flatMap((variant) => variantsFor(rule, variant)), [shape]);
  const choices = oneOf ? variants.flatMap((variant) => oneOf.map(({ properties }) => ({
    ...variant, properties: { ...variant.properties, ...properties },
  }))) : variants;
  return [name, choices.length === 1 ? choices[0] : { anyOf: choices }];
}));

const http = endpoints.filter(({ route }) => !route.startsWith("WS ") && route !== "GET /media/{id}").map(({ route, request, response }) => {
  const name = response.match(/`\d+(?:\/\d+)? (\w+)`/)?.[1];
  if (!definitions[name]) throw new Error(`Missing response schema for ${route}.`);
  const requestType = route === "POST /objects" ? "RegistrationFields"
    : route.startsWith("GET ") ? undefined : request.match(/`(\w+)`/)?.[1];
  if (!route.startsWith("GET ") && !requestType) throw new Error(`Could not extract request schema for ${route}.`);
  if (requestType && !definitions[requestType]) throw new Error(`Missing request schema for ${route}.`);
  return { route, name, requestType };
});
const types = await compile({
  ...seed,
  title: "HttpResponses",
  $defs: typeDefinitions,
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(http.map(({ route, name }) => [route, { $ref: `#/$defs/${name}` }])),
  required: http.map(({ route }) => route),
}, "HttpResponses", { bannerComment, unreachableDefinitions: true, maxItems: 10 });
const requestMap = `export interface HttpBodies {\n${http.filter(({ requestType }) => requestType).map(({ route, requestType }) =>
  `  "${route}": ${requestType};`).join("\n")}\n}`;
const componentNames = `export const componentNames = ${JSON.stringify(definitions.ComponentName.enum)} as const;`;

const directory = new URL("../src/generated/", import.meta.url);
const outputs = {
  "api-v1.seed.json": JSON.stringify(seed, null, 2) + "\n",
  "api-v1.ts": `${types.trimEnd()}\n\n${requestMap}\n\n${componentNames}\n`,
};

const check = process.argv.includes("--check");
if (!check) await mkdir(directory, { recursive: true });
for (const [name, content] of Object.entries(outputs)) {
  const output = new URL(name, directory);
  if (check) {
    const current = await readFile(output, "utf8").catch(() => "");
    if (current.replaceAll("\r\n", "\n") !== content) {
      console.error(`${name} is stale. Run npm run contracts:generate.`);
      process.exitCode = 1;
    }
  } else {
    await writeFile(output, content);
  }
}
