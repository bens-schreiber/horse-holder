/**
 * The API request handler: schema validation, authentication, and routing to Budget
 * Durable Objects.
 */

import { Result } from "better-result";

import { authenticate, issueKey } from "./auth.ts";
import {
  ApiError,
  Code,
  CommitBody,
  DrawBody,
  GroupHeader,
  Header,
  IdempotencyKeyHeader,
  Path,
  type Reply,
  RequiredHeader,
  ReservationTtlSecondsHeader,
  TenantHeader,
  parse,
  parseHeader,
  toResponse,
} from "./schema.ts";

/**
 * Serve one API request.
 */
export async function serve(request: Request, env: Env): Promise<Response> {
  // Expected failures already travel as `Result` errors, so anything that *throws* is a
  // defect.
  const handled = await Result.tryPromise({
    try: () => handle(request, env),
    catch: (cause) => {
      console.error(cause);
      return ApiError.error(500, Code.InternalError, "unexpected server failure");
    },
  });

  return toResponse(Result.flatten(handled));
}

const Routes = {
  [Path.Charge]: "POST",
  [Path.Reserve]: "POST",
  [Path.Release]: "POST",
  [Path.Commit]: "POST",
  [Path.Budget]: "GET",
  [Path.Keys]: "POST",
  [Path.Whoami]: "GET",
} as Record<string, "GET" | "POST">;

/** Validate a request and route it to the appropriate handler. */
function handle(request: Request, env: Env): Promise<Result<Reply, ApiError>> {
  const { pathname } = new URL(request.url);

  return Result.gen(async function* () {
    if (pathname === Path.Keys && Routes[Path.Keys] === request.method) {
      // The only unauthenticated endpoint is the one that issues a new account
      // and its first API key.
      const apiKey = await issueKey(env);
      return Result.ok(apiKey);
    }

    // All other endpoints are authenticated.
    // Resolve an account ID from the bearer token.
    const accountId = yield* Result.await(authenticate(request, env));

    const verb = Routes[pathname];
    if (verb === undefined) {
      return Result.err(ApiError.error(404, Code.NotFound, `unknown endpoint ${pathname}`));
    }
    if (verb !== request.method) {
      const message = `${request.method} is not allowed on ${pathname}`;
      return Result.err(ApiError.error(405, Code.MethodNotAllowed, message));
    }

    if (pathname === Path.Whoami) {
      // Echo the account ID back to the caller, so they can confirm which account
      // they are using.
      return Result.ok({ status: 200, body: { accountId } });
    }

    const group = yield* parseHeader(request, Header.Group, GroupHeader);
    // An absent `hh-tenant` and an empty one address different budgets, so presence is read
    // rather than inferred from the retrieved value.
    const tenant = request.headers.has(Header.Tenant)
      ? yield* parse(TenantHeader, request.headers.get(Header.Tenant), Header.Tenant)
      : null;
    const budgets = env.BUDGETS.get(env.BUDGETS.idFromName(doName(accountId, tenant, group)));

    if (pathname === Path.Budget) {
      // Read every budget in the group, in one atomic look at the object.
      return Result.ok(await budgets.read());
    }

    const body = yield* Result.await(readJson(request));

    if (pathname === Path.Charge || pathname === Path.Reserve) {
      // Idempotency key is required
      const key = yield* parseHeader(request, Header.IdempotencyKey, IdempotencyKeyHeader);

      const draw = { key, entries: (yield* parse(DrawBody, body, "body")).budgets };
      if (pathname === Path.Charge) {
        return Result.ok(await budgets.charge(draw));
      }

      const ttlSeconds = yield* parseHeader(
        request,
        Header.TtlSeconds,
        ReservationTtlSecondsHeader,
      );
      return Result.ok(await budgets.reserve(draw, ttlSeconds));
    }

    const reservationId = yield* parseHeader(request, Header.ReservationId, RequiredHeader);
    if (pathname === Path.Release) {
      return Result.ok(await budgets.release(reservationId));
    }

    // Commit body is optional (missing means no corrections to the reservation).
    const corrections = yield* parse(CommitBody, body ?? {}, "body");
    return Result.ok(await budgets.commit(reservationId, corrections.budgets));
  });
}

/**
 * The Durable Object name for a `(scope, tenant, group)` triple, where `null` is no tenant.
 */
export function doName(accountId: string, tenant: string | null, group: string): string {
  return `${accountId}:${tenant === null ? "0:" : `1:${tenant}`}:${group}`;
}

async function readJson(request: Request): Promise<Result<unknown, ApiError>> {
  const text = await request.text();
  if (text.trim() === "") {
    return Result.ok(null);
  }
  try {
    return Result.ok(JSON.parse(text));
  } catch {
    return Result.err(ApiError.invalid("body must be valid JSON"));
  }
}
