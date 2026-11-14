import { cache } from "react";
import { createTransport } from "@/lib/create-transport";
import type { ProtectedPath } from "@/lib/transport";

export const readApplication = cache(async () => {
  const transport = await createTransport();
  const bootstrap = await transport.bootstrap();

  return {
    async get<Path extends ProtectedPath>(path: Path, id?: string) {
      if (bootstrap.kind !== "ok") return bootstrap;
      return transport.get(path, { context: bootstrap.data, id });
    },
  };
});
