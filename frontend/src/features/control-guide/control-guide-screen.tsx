"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import layout from "@/components/layout/support-page.module.css";
import { useEligibleSearchSetup } from "@/features/runtime";
import { searchSetupHref, supportHref, type SearchSetupContext } from "@/lib/search-setup-context";
import { ControlGuideContent } from "./control-guide-content";

export function ControlGuideScreen({ setup }: { setup?: SearchSetupContext }) {
  const context = useEligibleSearchSetup(setup);
  return (
    <div className={layout.page}>
      <PageHeader title="Control Guide" description="Movement, stopping, match review and recovery." />
      <ControlGuideContent />
      <nav aria-label="Control Guide links" className={layout.footer}>
        <Link className="button button--secondary" href={supportHref("/devices", context)}>View Devices</Link>
        {context && <Link className="button button--primary" href={searchSetupHref(context)}>
          <ArrowRight size={18} aria-hidden="true" /> Return to Search Setup
        </Link>}
      </nav>
    </div>
  );
}
