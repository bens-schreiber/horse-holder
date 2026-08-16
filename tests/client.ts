/**
 * The vocabulary the conformance suite is written in: a scope you can draw against, and the
 * request bodies the protocol defines.
 *
 * Nothing here mentions API keys, KV, or Durable Objects. See `harness.ts` for the one file
 * that knows which server is answering.
 *
 * A test asks for a scope once and then speaks in operations rather than in HTTP:
 *
 * ```ts
 * const api = await scope();
 * const group = freshGroup();
 * const res = await api.charge({ group }, entry("put-ops", 1, definition(100)));
 * ```
 *
 * Everything a test does not care about has a default. An idempotency key is fresh unless the
 * test is *about* idempotency and pins one, so a test that only ever needed "a key, any key"
 * says nothing about keys at all.
 */

import { harness } from "./harness.ts";

export interface Options {
  group: string;
  /** Absent sends no `hh-tenant` header. `""` sends it empty, which is a different budget. */
  tenant?: string;
  /** Defaults to a fresh key, so only tests about idempotency need to say anything. */
  key?: string;
  ttl?: number;
  headers?: Record<string, string>;
}

/** One budget entry in a draw body. */
export interface Entry {
  id: string;
  amount: number;
  definition: Record<string, unknown>;
}

let counter = 0;

/** A unique group name, so tests never share an atomicity domain by accident. */
export function freshGroup(): string {
  counter += 1;
  return `g-${counter}-${Math.random().toString(36).slice(2)}`;
}

/** A unique idempotency key, since one is required per logical operation. */
export function freshKey(): string {
  counter += 1;
  return `key-${counter}-${Math.random().toString(36).slice(2)}`;
}

/** A minimal always-valid definition, so tests state only what they are exercising. */
export function definition(
  limit: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { limit, renewal: { type: "never" }, ...extra };
}

/** One budget entry for a draw body. */
export function entry(id: string, amount: number, def: Record<string, unknown>): Entry {
  return { id, amount, definition: def };
}

/** A fresh, empty, isolated scope, and the operations you can perform against it. */
export async function scope(): Promise<Scope> {
  return new Scope(await harness.newScope());
}

export class Scope {
  constructor(private readonly auth: Record<string, string>) {}

  charge(options: Options, ...budgets: Entry[]): Promise<Response> {
    return this.send("POST", "/v1/charge", options, { budgets });
  }

  reserve(options: Options, ...budgets: Entry[]): Promise<Response> {
    return this.send("POST", "/v1/reserve", options, { budgets });
  }

  /** Reserves and returns the id, failing loudly if the hold was refused. */
  async hold(options: Options, ...budgets: Entry[]): Promise<string> {
    const res = await this.reserve(options, ...budgets);
    if (res.status !== 200) {
      throw new Error(`reserve failed: ${res.status}`);
    }
    return (await json<{ reservationId: string }>(res)).reservationId;
  }

  commit(options: Options, reservationId: string, body?: unknown): Promise<Response> {
    return this.send("POST", "/v1/commit", reserved(options, reservationId), body);
  }

  release(options: Options, reservationId: string): Promise<Response> {
    return this.send("POST", "/v1/release", reserved(options, reservationId));
  }

  read(options: Options): Promise<Response> {
    return this.send("GET", "/v1/budget", options);
  }

  /** One budget's `used`, or `0` if it has never been drawn against. */
  async used(options: Options, id: string): Promise<number> {
    const res = await this.read(options);
    if (res.status !== 200) {
      return 0;
    }
    const { budgets } = await json<{ budgets: { id: string; used: number }[] }>(res);
    return budgets.find((budget) => budget.id === id)?.used ?? 0;
  }

  /** Escape hatch for the handful of tests that must send something malformed. */
  fetch(path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
    return harness.fetch(path, { ...init, headers: { ...this.auth, ...init.headers } });
  }

  private send(
    method: "GET" | "POST",
    path: string,
    options: Options,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = { ...this.auth, "hh-group": options.group };
    if (options.tenant !== undefined) {
      headers["hh-tenant"] = options.tenant;
    }
    if (options.ttl !== undefined) {
      headers["hh-ttl-seconds"] = String(options.ttl);
    }
    if (method === "POST" && path !== "/v1/commit" && path !== "/v1/release") {
      headers["idempotency-key"] = options.key ?? freshKey();
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    Object.assign(headers, options.headers);

    return harness.fetch(path, {
      method,
      headers,
      ...(body === undefined ? undefined : { body: JSON.stringify(body) }),
    });
  }
}

/** Reads a response body with the shape the test expects. */
export async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** The `error.code` a non-2xx carried, which most error assertions want and nothing else. */
export async function errorCode(response: Response): Promise<string> {
  return (await json<{ error: { code: string } }>(response)).error.code;
}

/** The `budgets` array, which every 200 and every 402 carries. */
export async function budgetsOf<T = Record<string, unknown>>(response: Response): Promise<T[]> {
  return (await json<{ budgets: T[] }>(response)).budgets;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reserved(options: Options, reservationId: string): Options {
  return { ...options, headers: { "hh-reservation-id": reservationId, ...options.headers } };
}
