"use client";

import { ChevronRight, Pause, Radio } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Panel } from "@/components/layout/panel";
import { DataUnavailable } from "@/components/layout/preview";
import { Button } from "@/components/ui/button";
import { LoadingState, Notice } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { useCursorPage, useRuntimeView } from "@/features/runtime";
import type { Object as ObjectRecord } from "@/generated/api-v1";
import { maxObjectNameLength, normalizeObjectName } from "@/lib/object-name";
import { objectHref, ObjectStatus, RecordReadFailure, RecordTime, ReferenceImage, RegisterLink, StartSearch } from "./record-ui";
import styles from "./records.module.css";

const filters = ["All", "Lost", "Found"] as const;
type Filter = (typeof filters)[number];

export function ObjectLibraryScreen() {
  const { disconnected, removedOwners } = useRuntimeView();
  const [name, setName] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const normalizedName = normalizeObjectName(name);
  const tooLong = [...normalizedName].length > maxObjectNameLength;
  const scope = useMemo(() => ({ query: {
    ...(normalizedName && { name: normalizedName }), ...(filter !== "All" && { status: filter }),
  } }), [filter, normalizedName]);
  const { result, page, hasPrevious, hasNext, next, previous, retry } = useCursorPage("GET /objects", scope, !tooLong);
  const filtered = Boolean(normalizedName || filter !== "All");
  const clear = () => { setName(""); setFilter("All"); };
  const items = result?.kind === "ok" ? result.data.items.filter(({ id }) => !removedOwners?.has(id)) : undefined;
  const showPaging = !tooLong && (!result || hasPrevious || Boolean(items?.length) || hasNext);
  if (disconnected) return <DataUnavailable />;

  return <div className={styles.recordLayout}>
    <PageHeader title="Objects / History" description="Find a belonging and review its record." actions={<RegisterLink />} />
    <ActiveSearchBanner />
    <div className={styles.filters}>
      <Field label="Search objects" type="search" placeholder="Search by object name…" value={name}
        error={tooLong ? `Enter no more than ${maxObjectNameLength} characters after trimming spaces.` : undefined}
        onChange={(event) => setName(event.target.value)} />
      <fieldset className={styles.statusFilters}>
        <legend>Object status</legend>
        {filters.map((status) => <Button key={status} variant={status === filter ? "primary" : "quiet"}
          aria-pressed={status === filter} onClick={() => setFilter(status)}>{status}</Button>)}
      </fieldset>
    </div>
    {!tooLong && (!result ? <LoadingState label="Loading objects" />
      : !items ? <RecordReadFailure title="Objects unavailable" retry={retry} />
      : <>
        {items.length > 0 ? <RecordList key={page} records={items} />
          : hasPrevious ? <Notice role="status" title="No records on this page">Use Previous to return to the preceding page.</Notice>
          : filtered ? <Panel>
            <div role="status"><h2>No matching objects</h2></div>
            <p>Try another name or clear your search and filters.</p>
            <Button onClick={clear}>Clear Search and Filters</Button>
          </Panel> : <Panel>
            <div role="status"><h2>No objects registered</h2></div>
            <p>Register a belonging and select its reference target to begin.</p>
          </Panel>}
      </>)}
    {!tooLong && <div className={styles.paging} hidden={!showPaging}>
      <p role="status">{items && `Page ${page} · ${items.length} ${items.length === 1 ? "object" : "objects"} · Newest first`}</p>
      <nav className="control-row" aria-label="Object pages">
        <Button aria-disabled={!hasPrevious || !result} onClick={previous}>Previous</Button>
        <Button aria-disabled={!hasNext} onClick={next}>Next</Button>
      </nav>
    </div>}
  </div>;
}

function ActiveSearchBanner() {
  const { snapshot } = useRuntimeView();
  const session = snapshot?.active_session;
  if (!session || !snapshot) return null;
  const state = snapshot.runtime.effective_session_state ?? session.state;
  if (state !== "Searching" && state !== "Paused") return null;
  const Icon = state === "Paused" ? Pause : Radio;
  return <section className={styles.activeSearch} aria-label="Active search">
    <Icon size={20} aria-hidden="true" />
    <div>
      <strong>{snapshot.active_object?.name} · {session.control_mode === "Gestures" ? "Gesture mode" : "PS4 mode"} · {state}</strong>
      <p>End this session before starting another search.</p>
    </div>
    <Link className="button button--secondary" href={`/sessions/${encodeURIComponent(session.id)}/live`}>Return to Active Search</Link>
  </section>;
}

function RecordList({ records }: { records: ObjectRecord[] }) {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = records.find(({ id }) => id === selectedId) ?? records[0];
  return <div className={styles.library}>
    <ul className={styles.rows} aria-label="Object records">
      {records.map((object) => <li className={styles.row} key={object.id} data-selected={object.id === selected.id}>
        <div className={styles.thumbnail}><ReferenceImage object={object} thumbnail /></div>
        <button className={styles.selectRecord} type="button" aria-label={`Preview ${object.name}`}
          aria-pressed={object.id === selected.id} onClick={() => setSelectedId(object.id)}>
          <strong>{object.name}</strong><RecordTime value={object.registered_at_ms} />
        </button>
        <ObjectStatus status={object.status} />
        <Link className={`button button--quiet ${styles.detailLink}`} href={objectHref(object.id)} aria-label={`View details for ${object.name}`}>
          <ChevronRight size={18} aria-hidden="true" />
        </Link>
      </li>)}
    </ul>
    <Panel className={styles.selected} aria-label="Selected object">
      <p className={styles.muted}>Selected object</p>
      <div className={styles.preview} key={selected.id}><ReferenceImage object={selected} /></div>
      <div className={styles.selectedHeading} role="status"><h2>{selected.name}</h2><ObjectStatus status={selected.status} /></div>
      <p className={styles.muted}>Registered <RecordTime value={selected.registered_at_ms} /></p>
      <div className={styles.previewActions}>
        <Link className="button button--secondary" href={objectHref(selected.id)}>View Object Details</Link>
        <StartSearch object={selected} />
      </div>
    </Panel>
  </div>;
}
