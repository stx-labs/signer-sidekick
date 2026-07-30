import { ApiRequestError } from "../api-client.js";

const GENERIC_REQUEST_PREFIX = /^(?:request failed:\s*)+/i;

function asSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

type SourcePosition = { stacksTipHeight: number; burnBlockHeight: number };

function sourcePosition(value: unknown): SourcePosition | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const stacksTipHeight = candidate.stacksTipHeight;
  const burnBlockHeight = candidate.burnBlockHeight;
  return typeof stacksTipHeight === "number" && typeof burnBlockHeight === "number"
    ? { stacksTipHeight, burnBlockHeight }
    : null;
}

function chainAnchorPositions(cause: unknown): string | null {
  if (
    !(cause instanceof ApiRequestError) ||
    (cause.code !== "chain_sources_out_of_sync" && cause.code !== "chain_anchor_unstable")
  ) {
    return null;
  }
  const node = sourcePosition(cause.body?.node);
  const api = sourcePosition(cause.body?.api);
  const poxBurnBlockHeight = cause.body?.poxBurnBlockHeight;
  if (!node || !api || typeof poxBurnBlockHeight !== "number") return null;
  return `Observed: node Stacks ${node.stacksTipHeight} / Bitcoin ${node.burnBlockHeight}; API Stacks ${api.stacksTipHeight} / Bitcoin ${api.burnBlockHeight}; PoX Bitcoin ${poxBurnBlockHeight}.`;
}

export function operatorErrorDetail(
  cause: unknown,
  fallback = "No diagnostic detail was returned",
): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : fallback;
  const detail = raw.trim().replace(GENERIC_REQUEST_PREFIX, "").trim() || fallback;
  const positions = chainAnchorPositions(cause);
  return positions ? `${detail} ${positions}` : detail;
}

export function operatorErrorSentence(
  cause: unknown,
  fallback = "No diagnostic detail was returned",
): string {
  return asSentence(operatorErrorDetail(cause, fallback));
}

function hasAuthoritativeHttpMessage(cause: unknown): boolean {
  return (
    cause instanceof ApiRequestError &&
    cause.kind === "http" &&
    Boolean(cause.body?.message?.trim())
  );
}

export function operatorActionError(
  cause: unknown,
  summary: string,
  recovery: string,
  fallback = "No diagnostic detail was returned",
): string {
  const action = asSentence(`${summary}: ${operatorErrorDetail(cause, fallback)}`);
  return hasAuthoritativeHttpMessage(cause) ? action : `${action} ${asSentence(recovery)}`;
}
