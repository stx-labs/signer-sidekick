import { type ApiError, apiErrorSchema } from "@stx-labs/signer-sidekick-api-contracts";

export const AUTH_REJECTED_EVENT = "sidekick-auth-rejected";
const DEFAULT_TIMEOUT_MS = 20_000;

export type ApiErrorKind = "authentication" | "transport" | "http" | "content";

export class ApiRequestError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly body: ApiError | null;

  constructor(
    message: string,
    options: {
      kind: ApiErrorKind;
      status?: number;
      code?: string;
      body?: ApiError;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "ApiRequestError";
    this.kind = options.kind;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.body = options.body ?? null;
  }
}

export interface ResponseSchema<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

export interface ApiJsonOptions extends RequestInit {
  timeoutMs?: number;
}

export interface ApiDownloadOptions extends RequestInit {
  expectedContentTypes: readonly string[];
  fallbackFilename: string;
  timeoutMs?: number;
}

function authenticatedHeaders(token: string, init: RequestInit): Headers {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined && init.body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
}

function requestLabel(url: string, init: RequestInit): string {
  const endpoint = url.split(/[?#]/, 1)[0] || url;
  return `${(init.method ?? "GET").toUpperCase()} ${endpoint}`;
}

function rejectAuthentication(): never {
  if (typeof sessionStorage !== "undefined") sessionStorage.removeItem("sidekick-token");
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_REJECTED_EVENT));
  throw new ApiRequestError("The operator credential was rejected.", {
    kind: "authentication",
    status: 401,
    code: "unauthorized",
  });
}

function mediaType(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isJsonMediaType(value: string): boolean {
  return value === "application/json" || value.endsWith("+json");
}

async function errorDetail(
  response: Response,
): Promise<{ code: string | null; detail: string; body: ApiError | null }> {
  if (isJsonMediaType(mediaType(response))) {
    const parsed = apiErrorSchema.safeParse(await response.json().catch(() => null));
    if (parsed.success) {
      return {
        code: parsed.data.error,
        detail: parsed.data.message?.trim() || parsed.data.error.replaceAll("_", " "),
        body: parsed.data,
      };
    }
  }
  return { code: null, detail: `HTTP ${response.status}`, body: null };
}

async function authenticatedFetch(
  token: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  const headers = authenticatedHeaders(token, init);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: init.credentials ?? "same-origin",
      headers,
      signal,
    });
  } catch (cause) {
    if (init.signal?.aborted) throw cause;
    const label = requestLabel(url, init);
    if (timeoutSignal.aborted) {
      throw new ApiRequestError(`Sidekick timed out during ${label}.`, {
        kind: "transport",
        cause,
      });
    }
    throw new ApiRequestError(
      `Could not reach Sidekick during ${label}. Check that it is running.`,
      {
        kind: "transport",
        cause,
      },
    );
  }
  if (response.status === 401) rejectAuthentication();
  if (!response.ok) {
    const { code, detail, body } = await errorDetail(response);
    throw new ApiRequestError(`Request failed: ${detail}`, {
      kind: "http",
      status: response.status,
      ...(code ? { code } : {}),
      ...(body ? { body } : {}),
    });
  }
  return response;
}

export async function apiJson<T>(
  token: string,
  url: string,
  schema: ResponseSchema<T>,
  options: ApiJsonOptions = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = options;
  const response = await authenticatedFetch(token, url, init, timeoutMs);
  const contentType = mediaType(response);
  if (!isJsonMediaType(contentType)) {
    throw new ApiRequestError(
      `Expected JSON from ${url}, received ${contentType || "no media type"}.`,
      {
        kind: "content",
        status: response.status,
      },
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new ApiRequestError(`Invalid JSON returned by ${url}.`, {
      kind: "content",
      status: response.status,
      cause,
    });
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiRequestError(`Invalid response returned by ${url}: ${result.error.message}`, {
      kind: "content",
      status: response.status,
      cause: result.error,
    });
  }
  return result.data;
}

export async function apiJsonOrUnavailable<T>(
  token: string,
  url: string,
  schema: ResponseSchema<T>,
  options: ApiJsonOptions = {},
): Promise<T | null> {
  try {
    return await apiJson(token, url, schema, options);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 501) return null;
    throw error;
  }
}

function filenameFromDisposition(disposition: string | null, fallback: string): string {
  const candidate = disposition?.match(/filename="([^"\r\n]+)"/i)?.[1] ?? fallback;
  const basename = candidate.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const sanitized = [...basename]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join("");
  return sanitized || fallback;
}

export async function apiDownload(
  token: string,
  url: string,
  options: ApiDownloadOptions,
): Promise<void> {
  const {
    expectedContentTypes,
    fallbackFilename,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    ...init
  } = options;
  const response = await authenticatedFetch(token, url, init, timeoutMs);
  const contentType = mediaType(response);
  if (!expectedContentTypes.map((value) => value.toLowerCase()).includes(contentType)) {
    throw new ApiRequestError(
      `Unexpected download media type from ${url}: ${contentType || "none"}.`,
      { kind: "content", status: response.status },
    );
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filenameFromDisposition(
      response.headers.get("content-disposition"),
      fallbackFilename,
    );
    anchor.click();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
