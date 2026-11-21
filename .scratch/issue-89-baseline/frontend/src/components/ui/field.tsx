import { Search } from "lucide-react";
import { useId, type ComponentPropsWithRef } from "react";

type InputProps = Omit<ComponentPropsWithRef<"input">, "type"> & {
  label: string;
  description?: string;
  error?: string;
};

function Input({
  label, description, error, id, required, type,
  "aria-describedby": describedBy, "aria-invalid": invalid, ...props
}: InputProps & { type: "text" | "search" | "number" | "checkbox" | "radio" }) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = `${inputId}-description`;
  const errorId = `${inputId}-error`;
  const choice = type === "checkbox" || type === "radio";
  const input = (
    <input
      {...props}
      id={inputId}
      type={type}
      required={required}
      aria-invalid={error ? true : invalid}
      aria-describedby={[describedBy, description && descriptionId, error && errorId].filter(Boolean).join(" ") || undefined}
    />
  );

  return (
    <div className={choice ? "field field--choice" : "field"}>
      <label className="field-label" htmlFor={inputId}>
        {label}{required && <span className="required-mark" aria-hidden="true"> (required)</span>}
      </label>
      {type === "search" ? (
        <div className="field-search"><Search aria-hidden="true" size={16} />{input}</div>
      ) : input}
      {description && <span className="control-hint" id={descriptionId}>{description}</span>}
      {error && <span className="field-error" id={errorId}>{error}</span>}
    </div>
  );
}

export function Field({ type = "text", ...props }: InputProps & { type?: "text" | "search" | "number" }) {
  return <Input {...props} type={type} />;
}

export function Choice({ type, ...props }: InputProps & { type: "checkbox" | "radio" }) {
  return <Input {...props} type={type} />;
}
