import { Check, CopySimple } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Some browsers expose the API but deny it; use the local selection fallback below.
    }
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Clipboard copy is unavailable");
}

export function CopyIdentifierButton({
  value,
  label = "identifier",
  showLabel = false,
}: {
  value: string | null | undefined;
  label?: string | undefined;
  showLabel?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const action = failed ? `Could not copy ${label}` : copied ? `Copied ${label}` : `Copy ${label}`;
  return (
    <button
      type="button"
      className={`copy-identifier-button${showLabel ? " copy-identifier-button-labeled" : ""}`}
      disabled={!value}
      aria-label={value && !copied ? `${action}: ${value}` : action}
      title={action}
      data-copy-state={failed ? "failed" : copied ? "copied" : "idle"}
      data-copy-value={value ?? undefined}
      onClick={async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!value) return;
        try {
          await copyText(value);
          setFailed(false);
          setCopied(true);
          if (resetTimer.current) clearTimeout(resetTimer.current);
          resetTimer.current = setTimeout(() => setCopied(false), 1_600);
        } catch {
          setCopied(false);
          setFailed(true);
          if (resetTimer.current) clearTimeout(resetTimer.current);
          resetTimer.current = setTimeout(() => setFailed(false), 3_000);
        }
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <CopySimple aria-hidden="true" />}
      {showLabel ? action : null}
      <span className="sr-only" aria-live="polite">
        {copied
          ? `Copied ${label}`
          : failed
            ? `Could not copy ${label}. Select and copy it manually.`
            : ""}
      </span>
    </button>
  );
}

export function CopyableIdentifier({
  value,
  display,
  label,
  className = "",
}: {
  value: string | null | undefined;
  display?: string;
  label?: string | undefined;
  className?: string;
}) {
  if (!value) return <span className={className}>—</span>;
  return (
    <span className={`copyable-identifier ${className}`.trim()} title={value}>
      <span className="copyable-identifier-value">{display ?? value}</span>
      <CopyIdentifierButton value={value} label={label} />
    </span>
  );
}
