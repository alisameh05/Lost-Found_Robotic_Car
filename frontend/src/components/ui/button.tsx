"use client";

import { LoaderCircle } from "lucide-react";
import { useId, type ComponentPropsWithRef } from "react";

type ButtonProps = ComponentPropsWithRef<"button"> & {
  variant?: "primary" | "secondary" | "quiet" | "destructive";
  disabledReason?: string;
  pending?: boolean;
};

export function Button({
  variant = "secondary", type = "button", disabled, disabledReason, pending, children,
  className, onClick, "aria-describedby": describedBy, ...props
}: ButtonProps) {
  const reasonId = useId();
  return (
    <>
      <button
        {...props}
        type={type}
        className={["button", `button--${variant}`, className].filter(Boolean).join(" ")}
        disabled={disabled || Boolean(disabledReason)}
        aria-disabled={pending || props["aria-disabled"]}
        aria-describedby={[describedBy, disabledReason && reasonId].filter(Boolean).join(" ") || undefined}
        data-pending={pending || undefined}
        onClick={(event) => {
          if (pending || props["aria-disabled"] === true || props["aria-disabled"] === "true") {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
      >
        {pending && <LoaderCircle aria-hidden="true" size={16} />}
        {children}
      </button>
      {disabledReason && <span id={reasonId} className="control-hint">{disabledReason}</span>}
    </>
  );
}
