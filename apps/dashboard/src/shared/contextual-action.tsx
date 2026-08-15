import { ArrowClockwise } from "@phosphor-icons/react";
import type { ContextualAction } from "@stx-labs/signer-sidekick-api-contracts";
import { actionHash, activityHash, domainHash, settingsHash } from "../dashboard-route.js";

export function ContextualActionControl({
  action,
  onRecheck,
  rechecking = false,
  emphasis = "secondary",
}: {
  action: ContextualAction;
  onRecheck: (target: Extract<ContextualAction, { kind: "recheck" }>["target"]) => void;
  rechecking?: boolean;
  emphasis?: "primary" | "secondary" | "tertiary";
}) {
  const className = `btn btn-${emphasis} sm`;
  if (action.kind === "recheck") {
    return (
      <button
        className={className}
        disabled={rechecking}
        onClick={() => onRecheck(action.target)}
        type="button"
      >
        <ArrowClockwise className={rechecking ? "spin" : undefined} />
        {rechecking ? "Refreshing" : action.label}
      </button>
    );
  }
  const href =
    action.kind === "launch-operation"
      ? actionHash(action.operation, action.context)
      : action.kind === "resume-activity"
        ? activityHash(action.activityId)
        : action.kind === "open-settings"
          ? settingsHash(action.section)
          : domainHash(action.page, action.section);
  return (
    <a className={className} href={href}>
      {action.label}
    </a>
  );
}
