/**
 * The vocabulary the conformance suite is written in: request headers, bodies, and the
 * small conveniences that keep each test stating only what it exercises.
 *
 * Nothing here mentions API keys, KV, or Durable Objects. See `harness.ts` for the one file
 * that knows which server is answering.
 */

export interface Harness {
  /** Headers granting access to a fresh, empty, isolated scope. */
  newScope(): Promise<Record<string, string>>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export interface RequestOptions {
  group?: string;
  tenant?: string | null;
  key?: string;
  ttl?: number;
  headers?: Record<string, string>;
}

/** Reads a response body with the shape the test expects. */
export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

let counter = 0;

/** A unique idempotency key, since one is required per logical operation. */
export function freshKey(): string {
  counter += 1;
  return `key-${counter}-${Math.random().toString(36).slice(2)}`;
}

/** A unique group name, so tests never share an atomicity domain by accident. */
export function freshGroup(): string {
  counter += 1;
  return `g-${counter}-${Math.random().toString(36).slice(2)}`;
}

/** Convenience wrapper: builds the standard request headers and posts a body. */
export function post(
  harness: Harness,
  auth: Record<string, string>,
  path: string,
  body: unknown,
  options: RequestOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    ...auth,
    "content-type": "application/json",
    "hh-group": options.group ?? "default-group",
    ...options.headers,
  };
  if (options.tenant !== undefined && options.tenant !== null) {
    headers["hh-tenant"] = options.tenant;
  }
  if (options.key !== undefined) {
    headers["idempotency-key"] = options.key;
  }
  if (options.ttl !== undefined) {
    headers["hh-ttl-seconds"] = String(options.ttl);
  }
  return harness.fetch(path, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function get(
  harness: Harness,
  auth: Record<string, string>,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    ...auth,
    "hh-group": options.group ?? "default-group",
    ...options.headers,
  };
  if (options.tenant !== undefined && options.tenant !== null) {
    headers["hh-tenant"] = options.tenant;
  }
  return harness.fetch(path, { method: "GET", headers });
}

/** A minimal always-valid definition, so tests state only what they are exercising. */
export function definition(
  limit: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { limit, renewal: { type: "never" }, ...extra };
}

/** One budget entry for a draw body. */
export function entry(
  id: string,
  amount: number,
  def: Record<string, unknown>,
): Record<string, unknown> {
  return { id, amount, definition: def };
}
