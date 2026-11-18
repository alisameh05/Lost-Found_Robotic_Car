import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";

const path = "backend/contracts/v1";
const source = new URL(`../../${path}/`, import.meta.url);
const documents = await Promise.all(["openapi.json", "schemas.json", "events.json", "frames.json"].map(async (name) =>
  (await readFile(new URL(name, source), "utf8")).replaceAll("\r\n", "\n")));
const [openapi, schema, events, frames] = documents.map((document) => JSON.parse(document));
const definitions = schema.$defs;

const referenceName = (value) => value?.$ref?.split("/").at(-1);
for (const definition of [events, events["x-laf-websocket"].incoming, frames, frames["x-laf-websocket"].bounds]) {
  if (!definitions[referenceName(definition)]) throw new Error("Missing realtime contract schema.");
}

const provenance = {
  path,
  version: openapi.info.version,
  sha256: createHash("sha256").update(documents.join("\n")).digest("hex"),
};
const seed = { ...schema, $comment: JSON.stringify(provenance) };
const bannerComment = `// Generated from ${path} (SHA-256 ${provenance.sha256}). Do not edit.`;

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

const http = Object.entries(openapi.paths).flatMap(([path, methods]) => Object.entries(methods).flatMap(([method, operation]) => {
  if (path === "/media/{id}") return [];
  const route = `${method.toUpperCase()} ${path}`;
  const success = Object.entries(operation.responses).find(([status]) => status.startsWith("2"))?.[1];
  const name = referenceName(success?.content["application/json"].schema);
  if (!definitions[name]) throw new Error(`Missing response schema for ${route}.`);
  const request = operation.requestBody?.content;
  const requestType = request?.["multipart/form-data"] ? "RegistrationFields" : referenceName(request?.["application/json"]?.schema);
  if (request && !definitions[requestType]) throw new Error(`Missing request schema for ${route}.`);
  return [{ route, name, requestType }];
}));
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
