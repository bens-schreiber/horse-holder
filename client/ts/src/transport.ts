/**
 * URLs, headers, timeouts, retries, and turning every failure into one error type.
 */

import { HorseHolderError, invalid, isHorseHolderError } from "./errors.ts";
import type { RequestOptions, Response$ } from "./types.ts";

/** Every header the protocol uses. Lowercase, which is the canonical form in HTTP/2. */
export const Header = {
  Authorization: "authorization",
  ContentType: "content-type",
  Group: "hh-group",
  IdempotencyKey: "idempotency-key",
  ReservationId: "hh-reservation-id",
  RetryAfter: "retry-after",
  Tenant: "hh-tenant",
  TtlSeconds: "hh-ttl-seconds",
} as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY = { attempts: 2, baseDelayMs: 100 };
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** The shape of `fetch` this client needs, so you can hand it your own. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** How hard to retry. */
export interface RetryOptions {
  /** Extra tries after the first one. Defaults to `2`. */
  readonly attempts?: number | undefined;
  /** Starting backoff delay in milliseconds, doubled each time. Defaults to `100`. */
  readonly baseDelayMs?: number | undefined;
}

/** Headers to send on every request, either fixed or computed fresh each time. */
export type HeaderSource =
  | Readonly<Record<string, string>>
  | (() => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>);

export interface TransportOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly headers?: HeaderSource | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly timeoutMs?: number | undefined;
  readonly retry?: RetryOptions | false | undefined;
}

export interface WireRequest {
  path: string;
  method: "GET" | "POST";
  group: string;
  /** `null` means send no tenant header at all. `""` means send it with an empty value. */
  tenant: string | null;
  headers: Record<string, string>;
  body?: unknown;
  options: RequestOptions;
}

export interface WireResult {
  status: number;
  body: unknown;
  headers: Headers;
}

export class Transport {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly retry: typeof DEFAULT_RETRY | false;
  private readonly staticHeaders: Readonly<Record<string, string>>;
  private readonly headerFn: Extract<HeaderSource, () => unknown> | undefined;

  constructor(options: TransportOptions) {
    if (options.baseUrl === "") {
      invalid("baseUrl must not be empty");
    }

    // Paths are appended as text rather than resolved as URLs, since
    // `new URL("/v1/charge", "https://host/api")` would quietly throw away the `/api` part.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");

    // Only the global needs rebinding. Binding a caller's own `fetch` would detach it from
    // whatever object it came off.
    this.fetch =
      options.fetch ??
      (typeof globalThis.fetch === "function"
        ? (globalThis.fetch.bind(globalThis) as FetchLike)
        : invalid("no fetch available: pass options.fetch or run on a runtime with global fetch"));

    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry =
      options.retry === false
        ? false
        : {
            attempts: options.retry?.attempts ?? DEFAULT_RETRY.attempts,
            baseDelayMs: options.retry?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
          };
    this.staticHeaders = {
      ...(options.apiKey === undefined
        ? undefined
        : { [Header.Authorization]: `Bearer ${options.apiKey}` }),
      ...(typeof options.headers === "function" ? undefined : options.headers),
    };
    this.headerFn = typeof options.headers === "function" ? options.headers : undefined;
  }

  async send(request: WireRequest): Promise<WireResult> {
    const retry = this.retry;
    const last = retry === false ? 0 : retry.attempts;

    for (let attempt = 0; ; attempt += 1) {
      let result: WireResult;
      try {
        result = await this.attempt(request);
      } catch (error) {
        // The same idempotency key goes out on every attempt, so a draw that actually landed
        // before the connection dropped gets replayed rather than applied twice.
        const retryable = isHorseHolderError(error) && error.status === null;
        if (attempt === last || !retryable) {
          throw error;
        }
        await sleep(this.backoff(attempt, null));
        continue;
      }

      if (result.status >= 200 && result.status < 300) {
        return result;
      }
      if (attempt === last || !isRetryable(result)) {
        return result;
      }
      await sleep(this.backoff(attempt, retryAfterSeconds(result.headers)));
    }
  }

  /** Exponential backoff with jitter, unless the server told us how long to wait. */
  private backoff(attempt: number, retryAfter: number | null): number {
    if (retryAfter !== null) {
      return retryAfter * 1000;
    }
    const { baseDelayMs } = this.retry === false ? DEFAULT_RETRY : this.retry;
    return Math.random() * baseDelayMs * 2 ** attempt;
  }

  private async attempt(request: WireRequest): Promise<WireResult> {
    const headers: Record<string, string> = {
      ...this.staticHeaders,
      ...(this.headerFn === undefined ? undefined : await this.headerFn()),
      [Header.Group]: request.group,
      ...request.headers,
      ...request.options.headers,
    };

    // Whether the header is present at all is the thing that matters, so this checks for
    // `null` rather than for emptiness. An empty tenant is a real tenant.
    if (request.tenant !== null) {
      headers[Header.Tenant] = request.tenant;
    }
    if (request.body !== undefined) {
      headers[Header.ContentType] = "application/json; charset=utf-8";
    }

    const timeoutMs = request.options.timeoutMs ?? this.timeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal =
      request.options.signal === undefined
        ? timeout
        : AbortSignal.any([timeout, request.options.signal]);

    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${request.path}`, {
        method: request.method,
        headers,
        signal,
        ...(request.body === undefined ? undefined : { body: JSON.stringify(request.body) }),
      });
    } catch (error) {
      const timedOut = timeout.aborted;
      throw new HorseHolderError({
        status: null,
        code: timedOut ? "timeout" : "network_error",
        message: timedOut
          ? `request to ${request.path} timed out after ${timeoutMs}ms`
          : `request to ${request.path} failed: ${String(error)}`,
        cause: error,
      });
    }

    return { status: response.status, body: await readBody(response), headers: response.headers };
  }
}

/** `retry-after` is in seconds. Missing or nonsense means we have no idea. */
export function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get(Header.RetryAfter);
  if (raw === null) {
    return null;
  }
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : null;
}

/** Turns a failed response into the one error type. */
export function toError(result: WireResult, context: string): HorseHolderError {
  const error = (result.body as Response$ | null)?.error;
  return new HorseHolderError({
    status: result.status,
    code: error?.code ?? "unknown_error",
    message: error?.message ?? `${context} failed with status ${result.status}`,
    body: result.body,
  });
}

function isRetryable(result: WireResult): boolean {
  if (RETRYABLE_STATUSES.has(result.status)) {
    return true;
  }
  // A duplicate request still in flight will have an answer shortly.
  const code = (result.body as Response$ | null)?.error?.code;
  return result.status === 409 && code === "idempotency_in_progress";
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
