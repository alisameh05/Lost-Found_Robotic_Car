import { dirname, posix } from "node:path";
import { defineConfig, globalIgnores } from "eslint/config";
import next from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

function sourcePath(filename) {
  return filename.replaceAll("\\", "/").split("/src/").at(-1);
}

const architecture = {
  meta: { schema: [], messages: { boundary: "Import {{target}} through an allowed public module." } },
  create(context) {
    function check(node) {
      if (typeof node?.value !== "string") return;
      const from = sourcePath(context.filename);
      const specifier = node.value;
      let to;
      if (specifier.startsWith("@/")) to = specifier.slice(2);
      else if (specifier.startsWith(".")) to = posix.normalize(posix.join(dirname(from).replaceAll("\\", "/"), specifier));
      else return;

      const [layer, feature] = from.split("/");
      const [targetLayer, targetFeature, entry] = to.split("/");
      const publicEntry = !entry || /^index(?:\.[cm]?[jt]sx?)?$/.test(entry);
      const siblingAllows = {
        dashboard: ["objects", "search"],
        search: ["objects", "devices", "control-guide"],
      };

      const featureAllowed = targetLayer !== "features" ||
        (layer === "app" && publicEntry) ||
        (layer === "features" && (feature === targetFeature ||
          (publicEntry && feature !== "runtime" &&
            (targetFeature === "runtime" || siblingAllows[feature]?.includes(targetFeature)))));

      if (!featureAllowed || (targetLayer === "app" && layer !== "app") ||
          (layer === "lib" && targetLayer === "components") ||
          (from.startsWith("app/") && to.startsWith("lib/fixtures/"))) {
        context.report({ node, messageId: "boundary", data: { target: specifier } });
      }
    }

    return {
      ImportDeclaration: ({ source }) => check(source),
      ExportAllDeclaration: ({ source }) => check(source),
      ExportNamedDeclaration: ({ source }) => check(source),
      ImportExpression: ({ source }) => check(source),
    };
  },
};

export default defineConfig(
  next,
  nextTypeScript,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { local: { rules: { "architecture-imports": architecture } } },
    rules: { "local/architecture-imports": "error" },
  },
  globalIgnores([".next/**", "next-env.d.ts", "src/generated/**", "playwright-report/**", "test-results/**"]),
);
