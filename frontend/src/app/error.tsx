"use client";

import { Preview } from "@/components/layout/preview";

export default function RouteError({ reset }: { reset: () => void }) {
  return (
    <>
      <Preview title="Unable to open this preview" description="Try loading the current destination again." />
      <button type="button" onClick={reset}>Try again</button>
    </>
  );
}
