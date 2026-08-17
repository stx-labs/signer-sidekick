import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { parseEndpointUrl } from "./config.js";
import { currentInteractiveRequestSignal } from "./request-context.js";

const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 3_000;

export class HealthSourceError extends Error {
  constructor(
    readonly code:
      | "invalid-url"
      | "unsafe-address"
      | "dns-unavailable"
      | "connection-failed"
      | "timeout"
      | "response-too-large"
      | "authentication-required"
      | "authentication-rejected"
      | "rate-limited"
      | "http-error"
      | "unexpected-content",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HealthSourceError";
  }
}

export interface HealthHttpResponse {
  body: string;
  contentType: string | null;
  latencyMs: number;
  status: number;
}

function ipv4Parts(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

function mappedIpv4(address: string): string | null {
  const normalized = address.toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  if (dotted && isIP(dotted) === 4) return dotted;
  const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (!hexadecimal?.[1] || !hexadecimal[2]) return null;
  const high = Number.parseInt(hexadecimal[1], 16);
  const low = Number.parseInt(hexadecimal[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

export function isDeniedHealthAddress(input: string): boolean {
  const address = mappedIpv4(input) ?? input;
  const parts = ipv4Parts(address);
  if (parts) {
    const [a = 0, b = 0, c = 0, d = 0] = parts;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true;
    if (a === 100 && b === 100 && c === 100 && d === 200) return true;
    return false;
  }
  if (isIP(address) !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized === "::") return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9")) return true;
  if (normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized === "fd00:ec2::254") return true;
  return false;
}

export function validateHealthEndpointUrl(value: string, name = "Health endpoint URL"): string {
  try {
    return parseEndpointUrl(value, name);
  } catch (error) {
    throw new HealthSourceError("invalid-url", `${name} is invalid`, { cause: error });
  }
}

async function resolveAllowedAddress(
  url: URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{ address: string; family: 4 | 6 }> {
  signal?.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (isDeniedHealthAddress(hostname)) {
      throw new HealthSourceError(
        "unsafe-address",
        "Health endpoint resolves to a blocked address",
      );
    }
    return { address: hostname, family: isIP(hostname) as 4 | 6 };
  }
  let addresses: LookupAddress[];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const candidates: Array<Promise<LookupAddress[]>> = [
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new HealthSourceError("timeout", "Health endpoint DNS timed out")),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ];
    if (signal) {
      candidates.push(
        new Promise<never>((_resolve, reject) => {
          cancel = () => reject(signal.reason);
          signal.addEventListener("abort", cancel, { once: true });
        }),
      );
    }
    addresses = await Promise.race(candidates);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof HealthSourceError) throw error;
    throw new HealthSourceError("dns-unavailable", "Health endpoint DNS is unavailable", {
      cause: error,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (cancel) signal?.removeEventListener("abort", cancel);
  }
  signal?.throwIfAborted();
  if (addresses.length === 0) {
    throw new HealthSourceError("dns-unavailable", "Health endpoint DNS returned no addresses");
  }
  if (addresses.some(({ address }) => isDeniedHealthAddress(address))) {
    throw new HealthSourceError("unsafe-address", "Health endpoint resolves to a blocked address");
  }
  const selected = addresses.find(({ family }) => family === 4) ?? addresses[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) {
    throw new HealthSourceError(
      "dns-unavailable",
      "Health endpoint DNS returned no usable address",
    );
  }
  return { address: selected.address, family: selected.family };
}

/**
 * Validate a persisted endpoint without requiring it to be online. Literal and currently
 * resolvable blocked addresses fail; an unresolved private hostname may be saved before startup.
 */
export async function validateHealthEndpointForSave(
  value: string,
  name = "Health endpoint URL",
  signal = currentInteractiveRequestSignal(),
): Promise<string> {
  signal?.throwIfAborted();
  const normalized = validateHealthEndpointUrl(value, name);
  try {
    await resolveAllowedAddress(new URL(normalized), DEFAULT_TIMEOUT_MS, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof HealthSourceError && error.code === "dns-unavailable") return normalized;
    throw error;
  }
  signal?.throwIfAborted();
  return normalized;
}

export async function fetchHealthSource(
  input: string,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    headers?: Readonly<Record<string, string>>;
  } = {},
): Promise<HealthHttpResponse> {
  const normalized = validateHealthEndpointUrl(input);
  const url = new URL(normalized);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const startedAt = performance.now();
  const resolved = await resolveAllowedAddress(url, timeoutMs);
  const remainingMs = Math.max(1, timeoutMs - Math.round(performance.now() - startedAt));
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise<HealthHttpResponse>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finishError = (error: HealthSourceError) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      reject(error);
    };
    const outgoing = request(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json, text/plain; q=0.9, */*; q=0.1",
          ...options.headers,
        },
        lookup: ((_, lookupOptions, callback) => {
          if (lookupOptions.all) {
            callback(null, [resolved]);
            return;
          }
          callback(null, resolved.address, resolved.family);
        }) satisfies LookupFunction,
        servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > maxBytes) {
            response.destroy();
            finishError(
              new HealthSourceError("response-too-large", "Health endpoint response is too large"),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          if (settled) return;
          if (status < 200 || status >= 300) {
            const code =
              status === 401
                ? "authentication-required"
                : status === 403
                  ? "authentication-rejected"
                  : status === 429
                    ? "rate-limited"
                    : "http-error";
            finishError(new HealthSourceError(code, `Health endpoint returned HTTP ${status}`));
            return;
          }
          settled = true;
          if (deadline) clearTimeout(deadline);
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            contentType:
              typeof response.headers["content-type"] === "string"
                ? response.headers["content-type"]
                : null,
            latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
            status,
          });
        });
        response.on("error", (error) => {
          finishError(
            new HealthSourceError("connection-failed", "Health endpoint response failed", {
              cause: error,
            }),
          );
        });
      },
    );
    deadline = setTimeout(() => {
      outgoing.destroy();
      finishError(new HealthSourceError("timeout", "Health endpoint request timed out"));
    }, remainingMs);
    deadline.unref?.();
    outgoing.on("error", (error) => {
      finishError(
        new HealthSourceError("connection-failed", "Health endpoint connection failed", {
          cause: error,
        }),
      );
    });
    outgoing.end();
  });
}
