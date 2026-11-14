import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const command = process.argv[2];
const port = process.env.LAF_FRONTEND_PORT ?? "3000";
if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error("LAF_FRONTEND_PORT must be an integer from 1 to 65535.");
}

// Giving Next an explicit port disables its development port fallback.
const server = spawn(process.execPath, [
  require.resolve("next/dist/bin/next"),
  command,
  "--hostname", "127.0.0.1",
  "--port", port,
], { stdio: "inherit" });
server.on("exit", (code) => { process.exitCode = code ?? 1; });
server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
