"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronRight, Trash2, Upload } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/feedback";
import { useRuntime, useRuntimeView, type RuntimeProjection } from "@/features/runtime";
import { isValidObjectName, normalizeObjectName } from "@/lib/object-name";
import { coordinates, emptySelection, readSelection, selectionFields } from "./selection";
import { RegionPreview, TargetEditor } from "./target-editor";
import { useReference } from "./use-reference";
import { pendingRegistration, useRegistration } from "./use-registration";
import styles from "./registration.module.css";

const labels = { x: "X", y: "Y", width: "Width", height: "Height" };

export function RegistrationScreen() {
  const state = useRuntime();
  return <RegistrationForm key={state?.selection.generation} runtime={state?.connection?.runtime} />;
}

function RegistrationForm({ runtime }: { runtime?: RuntimeProjection }) {
  const [recovered] = useState(() => pendingRegistration(runtime)?.body);
  const [target, setTarget] = useState(Boolean(recovered));
  const [name, setName] = useState(recovered?.name ?? "");
  const [file, setFile] = useState(recovered?.reference_image instanceof File ? recovered.reference_image : undefined);
  const [selection, setSelection] = useState(recovered ? selectionFields(recovered.roi) : emptySelection);
  const [validate, setValidate] = useState(false);
  const [dropError, setDropError] = useState("");
  const { image, imageError, loading } = useReference(file);
  const { save, locked, busy, submit, retry, clearFailure } = useRegistration(runtime);
  const { connected } = useRuntimeView();
  const picker = useRef<HTMLInputElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const xField = useRef<HTMLInputElement>(null);
  const moveFocus = useRef(false);

  useEffect(() => {
    if (!moveFocus.current) return;
    (target ? xField : nameField).current?.focus();
    moveFocus.current = false;
  }, [target]);

  const normalizedName = normalizeObjectName(name);
  const invalidName = !isValidObjectName(normalizedName);
  const result = image ? readSelection(selection, image) : undefined;
  const rect = result?.rect ?? null;
  const hasSelection = coordinates.some((key) => selection[key] !== "");
  const error = save?.kind === "failed" ? save.error : undefined;
  const expired = error?.code === "ACTION_EXPIRED" || error?.code === "EXPIRED";
  const fieldError = (path: string) => error?.field_errors?.find((field) => field.path === path)?.message;
  const referenceError = imageError || dropError || fieldError("/reference_image") ||
    (validate && !file ? "Choose a reference image." : undefined);

  function choose(files: FileList | null) {
    if (!files?.length || locked) return;
    setSelection(emptySelection);
    clearFailure();
    setFile(files.length === 1 ? files[0] : undefined);
    setDropError(files.length === 1 ? "" : "Choose one reference image.");
  }

  function advance(event: FormEvent) {
    event.preventDefault();
    if (locked) return;
    if (target) {
      if (connected && file && rect && !invalidName) submit({ name: normalizedName, reference_image: file, roi: rect });
    } else {
      setValidate(true);
      if (!invalidName && image) {
        setName(normalizedName);
        moveFocus.current = true;
        setTarget(true);
      } else if (invalidName) nameField.current?.focus();
    }
  }

  return (
    <>
      <div className={styles.heading}><PageHeader title={target ? "Select Target" : "Register Object"}
        description={target ? `Step 2 of 2 · ${normalizedName} · Select one rectangle around the belonging.`
          : "Step 1 of 2 · Add the object name and reference image."} /></div>
      <ol className={styles.steps} aria-label="Registration steps">
        <li aria-current={!target ? "step" : undefined}><span>{target ? <Check size={16} aria-label="Completed" /> : "1"}</span>Object information</li>
        <li className={styles.separator} aria-hidden="true"><ChevronRight size={18} /></li>
        <li aria-current={target ? "step" : undefined}><span>2</span>Select target</li>
      </ol>
      {error && <Notice title={expired ? "Registration expired"
        : error.code === "ACTION_ID_CONFLICT" ? "Registration conflict" : "Registration failed"} tone="danger" role="alert">
        {error.message}
        {expired || error.code === "ACTION_ID_CONFLICT" ? " Review the draft and select Register Object to start a new request." : ""}
        {fieldError("/name") && <p>Object name · {fieldError("/name")}</p>}
        {fieldError("/reference_image") && <p>Reference image · {fieldError("/reference_image")}</p>}
        {fieldError("/roi") && <p>Selection · {fieldError("/roi")}</p>}
      </Notice>}
      <div role="status" aria-live="polite">
        {save?.kind === "sending" && <Notice title="Saving registration…" />}
        {save?.kind === "pending" && <Notice title="Registration pending">The application is still saving this request.</Notice>}
        {save?.kind === "uncertain" && <Notice title="Registration outcome unknown" tone="warning">Retry the same request to recover its result.</Notice>}
      </div>
      <form className={styles.form} onSubmit={advance} noValidate>
        {target ? (
          <div className={styles.columns}>
            <section>
              <div className={styles.sectionHeading}>
                <h2>Reference image</h2>
                <Button disabled={locked || !hasSelection} onClick={() => { setSelection(emptySelection); clearFailure(); }}>Reset Selection</Button>
              </div>
              {image && <>
                <TargetEditor image={image} rect={rect} disabled={locked} onSelection={(next) => { setSelection(selectionFields(next)); clearFailure(); }} />
                <p className="control-hint">{file?.name} · {image.width} × {image.height} px</p>
              </>}
            </section>
            <section>
              <h2>Selected-region preview</h2>
              {image && <RegionPreview image={image} rect={rect} />}
              <p className="control-hint">Only this region becomes the search target.</p>
              <h3>Selection coordinates</h3>
              <div className={styles.coordinates}>
                {coordinates.map((key) => <Field key={key} label={`${labels[key]} · px`} value={selection[key]}
                  inputMode="numeric" disabled={locked} ref={key === "x" ? xField : undefined}
                  onChange={(event) => { setSelection({ ...selection, [key]: event.target.value }); clearFailure(); }}
                  error={fieldError(`/roi/${key}`) || (selection[key] || coordinates.every((part) => selection[part])
                    ? result?.errors[key] : undefined)} />)}
              </div>
              <p className="control-hint">Use normalized image pixels. Enter coordinates to adjust the rectangle with the keyboard.</p>
              <p className={rect ? styles.valid : "control-hint"} role="status">
                {rect ? `Valid rectangle · ${rect.width} × ${rect.height} px`
                  : hasSelection ? "Enter four valid coordinates to select a region." : "No region selected."}
              </p>
            </section>
          </div>
        ) : (
          <div className={styles.columns}>
            <section>
              <h2>Reference image (required)</h2>
              <div className={styles.upload} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
                onDrop={(event) => { event.preventDefault(); choose(event.dataTransfer.files); }}>
                <input type="file" ref={picker} accept="image/jpeg,image/png,.jpg,.jpeg,.png" aria-label="Reference image"
                  hidden onChange={(event) => { choose(event.target.files); event.target.value = ""; }} />
                {image ? <>
                  <div className={styles.stage}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- Local, temporary normalized preview. */}
                    <img src={image.url} alt="Normalized reference preview" />
                  </div>
                  <p className={styles.filename}>{file?.name}</p>
                  <p className="control-hint">{((file?.size ?? 0) / 1048576).toFixed(2)} MiB · {image.width} × {image.height} px</p>
                  <div className={styles.actions}>
                    <Button onClick={() => picker.current?.click()}>Replace Image</Button>
                    <Button variant="destructive" onClick={() => { setFile(undefined); setSelection(emptySelection); setDropError(""); clearFailure(); }}>
                      <Trash2 size={16} aria-hidden="true" /> Remove Image
                    </Button>
                  </div>
                </> : <div className={`${styles.stage} ${styles.drop}`}>
                  <Upload size={28} aria-hidden="true" />
                  <p role="status">{loading ? "Reading reference image…" : "Drag and drop a reference image here"}</p>
                  <Button onClick={() => picker.current?.click()}>{loading ? "Choose Another Image" : "Choose Image"}</Button>
                </div>}
                {referenceError && <p className="field-error" role="alert">{referenceError}</p>}
              </div>
            </section>
            <section>
              <h2>Object information</h2>
              <Field label="Object name" required ref={nameField} value={name}
                description="Use a name you will recognize in your object library."
                error={fieldError("/name") || (validate && invalidName ? "Enter a name with 1 to 120 characters." : undefined)}
                onChange={(event) => { setName(event.target.value); clearFailure(); }} />
              <h2 className={styles.requirements}>Reference image</h2>
              <p>Choose a clear photo that includes the belonging you want to find.</p>
              <p className="control-hint">JPEG or PNG · Up to 10 MiB and 20 megapixels</p>
              <Notice title="Choose the target next">In step 2, select one rectangle inside the reference image.</Notice>
            </section>
          </div>
        )}
        <div className={styles.footer}>
          <div>
            <strong>{target ? normalizedName : "Next step · Select the target"}</strong>
            <p className="control-hint">{target ? "Saving opens the new Object Details." : "You can return from step 2 without losing these details."}</p>
            {target && !connected && <p className="field-error">Registration is unavailable until the application is connected.</p>}
          </div>
          <div className={styles.actions}>
            {target ? <>
              <Button disabled={locked} onClick={() => { moveFocus.current = true; setTarget(false); }}>Back</Button>
              {locked && save?.kind !== "sending"
                ? <Button variant="primary" pending={busy} onClick={retry}>Retry Same Request</Button>
                : <Button type="submit" variant="primary" pending={save?.kind === "sending"}
                  disabled={!connected || !rect || invalidName}><Check size={18} aria-hidden="true" /> Register Object</Button>}
            </> : <>
              <Link href="/objects" className="button button--secondary">Cancel</Link>
              <Button type="submit" variant="primary"><ArrowRight size={18} aria-hidden="true" /> Next</Button>
            </>}
          </div>
        </div>
      </form>
    </>
  );
}
