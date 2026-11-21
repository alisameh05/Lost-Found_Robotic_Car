import Ajv2020 from "ajv/dist/2020";
import seed from "@/generated/api-v1.seed.json";

const validator = new Ajv2020({ strict: false });
validator.addSchema(seed, "api-v1");
export type Definition = keyof typeof seed.$defs;

export function conforms(definition: Definition, value: unknown): boolean {
  return validator.validate(`api-v1#/$defs/${definition}`, value);
}
