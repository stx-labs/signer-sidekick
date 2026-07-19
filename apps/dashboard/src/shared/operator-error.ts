import { ApiRequestError } from "../api-client.js";

const GENERIC_REQUEST_PREFIX = /^(?:request failed:\s*)+/i;

function asSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function operatorErrorDetail(
  cause: unknown,
  fallback = "No diagnostic detail was returned",
): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : fallback;
  return raw.trim().replace(GENERIC_REQUEST_PREFIX, "").trim() || fallback;
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
