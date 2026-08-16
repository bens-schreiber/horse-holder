/**
 * Worker entry point for the Horse Holder API.
 *
 * All request schema validation, authentication, and routing to Budget Durable Objects
 * is handled here.
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
  parse,
  parseHeader,
  Path,
  type Reply,
  RequiredHeader,
  TenantHeader,
  toResponse,
  ReservationTtlSecondsHeader,
} from "./schema.ts";

export { BudgetGroup } from "./budget.ts";

export default {
  async fetch(request, env) {
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
  },
} satisfies ExportedHandler<Env>;

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
    const tenant = yield* parse(
      TenantHeader,
      request.headers.get(Header.Tenant) ?? "",
      Header.Tenant,
    );
    const hasTenant = request.headers.has(Header.Tenant);
    const name = doName(accountId, hasTenant, tenant, group);
    const budgets = env.BUDGETS.get(env.BUDGETS.idFromName(name));

    if (pathname === Path.Budget) {
      // Read the state of a single budget.
      const id = yield* parseHeader(request, Header.BudgetId, RequiredHeader);
      const budget = await budgets.read(id);
      return Result.ok(budget);
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
 * The Durable Object name for a `(scope, tenant, group)` triple.
 *
 * `:` is explicitly outside the identifier charset.
 */
export function doName(
  accountId: string,
  tenantPresent: boolean,
  tenant: string,
  group: string,
): string {
  return `${accountId}:${tenantPresent ? "1" : "0"}:${tenant}:${group}`;
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
