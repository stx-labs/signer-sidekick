import { createHash } from "node:crypto";

export interface ManagerInterfaceFingerprintInput {
  clarity_version?: string | null | undefined;
  epoch?: string | null | undefined;
  functions?: readonly unknown[];
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry)}`)
    .join(",")}}`;
}

/**
 * Bind a manager interface fingerprint to callable ABI and deployed Clarity semantics.
 * Function order is normalized because indexers do not promise a stable ABI ordering.
 */
export function managerInterfaceSha256(input: ManagerInterfaceFingerprintInput): string {
  const functions = [...(input.functions ?? [])].sort((left, right) =>
    canonicalValue(left).localeCompare(canonicalValue(right)),
  );
  return createHash("sha256")
    .update(
      canonicalValue({
        clarityVersion: input.clarity_version ?? null,
        epoch: input.epoch ?? null,
        functions,
      }),
    )
    .digest("hex");
}
