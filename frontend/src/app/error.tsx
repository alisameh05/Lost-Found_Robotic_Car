"use client";

import { Preview } from "@/components/layout/preview";
import { Button } from "@/components/ui/button";

export default function RouteError({ retry }: { retry: () => void }) {
  return (
    <>
      <Preview title="Unable to open this preview" description="Try loading the current destination again." />
      <Button onClick={retry}>Try again</Button>
    </>
  );
}
