/**
 * What a group carries around, how a request gets made, and how a response becomes a result.
 *
 * Nothing in here is exported from the package. A group, a draw, and a reservation are three
 * views onto the same {@link Session}, which is why they can hand it to each other rather than
 * each holding a transport, a tenant, and a copy of the budget definitions.
 */

import { HorseHolderError, invalid } from "./errors.ts";
import {
  Header,
  type Transport,
  type WireResult,
  retryAfterSeconds,
  toError,
} from "./transport.ts";
import {
  type Amounts,
  type BudgetOutcome,
  type BudgetSpec,
  type DrawFailed,
  type DrawOk,
  type DrawResult,
  type DrawnBudget,
  ID_PATTERN,
  type RequestOptions,
  type Reservation,
  type Response$,
  type WarningCrossing,
  type WarningHandler,
} from "./types.ts";

/** The endpoints of the protocol. */
export const Path = {
  Budget: "/v1/budget",
  Charge: "/v1/charge",
  Commit: "/v1/commit",
  Release: "/v1/release",
  Reserve: "/v1/reserve",
} as const;

/** Everything a group knows, and everything a draw or a reservation needs from it. */
export interface Session {
  readonly transport: Transport;
  /** The group name. */
  readonly group: string;
  /** Every budget declared so far, keyed by id. Immutable: `.budget()` copies it. */
  readonly budgets: Readonly<Record<string, BudgetSpec>>;
  /** The tenant this view is bound to. `null` means send no tenant header. */
  readonly tenant: string | null;
  readonly onWarning: WarningHandler | undefined;
}

/** A copy of `session` bound to a different tenant. */
export function withTenant(session: Session, tenant: string | null): Session {
  assertTenant(tenant);
  return { ...session, tenant };
}

/** Left out means inherit whatever the builder was bound to; `null` and `""` mean themselves. */
export function tenantFor(session: Session, options: RequestOptions | undefined): string | null {
  if (options?.tenant === undefined) {
    return session.tenant;
  }
  assertTenant(options.tenant);
  return options.tenant;
}

/** One request that moves budgets: a charge, a reserve, a commit, or a release. */
export interface DrawRequest {
  path: string;
  /** Headers beyond the group and tenant: an idempotency key, a reservation id, a TTL. */
  headers: Record<string, string>;
  body?: unknown;
  options: RequestOptions | undefined;
  /** Names the operation in any error thrown, so a failure says which call it came from. */
  context: string;
  /**
   * Whether a `402` is an answer rather than a failure.
   *
   * True for anything that could find a budget short, so running out comes back as
   * `ok: false`. A release spends nothing and so can only ever succeed.
   */
  refusable: boolean;
}

/**
 * Send it, then turn the response into the result the caller branches on.
 *
 * Every operation that moves a budget goes through here, which is what keeps "a 402 is a value,
 * everything else throws" true in one place rather than at five call sites.
 */
export async function draw<Ids extends string>(
  session: Session,
  request: DrawRequest,
): Promise<DrawResult<Ids>> {
  const tenant = tenantFor(session, request.options);
  const result = await session.transport.send({
    path: request.path,
    method: "POST",
    group: session.group,
    tenant,
    headers: request.headers,
    ...(request.body === undefined ? undefined : { body: request.body }),
    options: request.options ?? {},
  });

  if (result.status !== 200 && !(request.refusable && result.status === 402)) {
    throw toError(result, request.context);
  }
  return decode<Ids>(session, tenant, result);
}

/** Turns a `200` or a `402` into the result the caller branches on. */
function decode<Ids extends string>(
  session: Session,
  tenant: string | null,
  result: WireResult,
): DrawResult<Ids> {
  const outcomes = budgetsOf(result.body).map((wire) => ({
    id: wire.id,
    requested: wire.requested,
    exceeded: wire.exceeded,
    limit: wire.limit,
    used: wire.used,
    remaining: wire.remaining,
    renewsAt: toDate(wire.renewsAt),
    warningsCrossed: wire.warningsCrossed,
  }));

  const get = (id: Ids): BudgetOutcome => {
    const found = outcomes.find((outcome) => outcome.id === id);
    if (found !== undefined) {
      return found;
    }

    // A budget you declared but have never drawn from does not exist on the server yet, so it
    // is missing from the response. Its state is still known: nothing spent, everything
    // remaining. Reporting that beats handing back undefined for a budget the caller can see
    // in its own group.
    const spec = session.budgets[id];
    if (spec === undefined) {
      invalid(
        `budget ${JSON.stringify(id)} is not declared in group ${JSON.stringify(session.group)}`,
      );
    }
    return {
      id,
      requested: 0,
      exceeded: false,
      limit: spec.limit,
      used: 0,
      remaining: spec.limit,
      renewsAt: null,
      warningsCrossed: [],
    };
  };

  if (result.status === 402) {
    return {
      ok: false,
      budgets: outcomes,
      exceeded: outcomes.filter((outcome) => outcome.exceeded),
      retryAfter: retryAfterSeconds(result.headers),
      get,
      raw: result.body,
    } satisfies DrawFailed<Ids>;
  }

  const warningsCrossed: WarningCrossing<Ids>[] = [];
  for (const outcome of outcomes) {
    if (outcome.warningsCrossed.length === 0) {
      continue;
    }
    warningsCrossed.push({ id: outcome.id as Ids, thresholds: outcome.warningsCrossed });
    session.onWarning?.({
      group: session.group,
      tenant,
      id: outcome.id,
      thresholds: outcome.warningsCrossed,
      budget: outcome,
    });
  }

  return { ok: true, budgets: outcomes, warningsCrossed, get, raw: result.body };
}

/**
 * A handle on one hold, and the two ways to finish with it.
 *
 * `Held` is a type-level claim about which budgets the hold covers. A lease knows this for
 * certain because it made the reservation; `group.reservation(id)` cannot know it and so
 * accepts any budget in the group.
 *
 * It lives here rather than on either builder because both of them hand one out: a group from
 * an id you carried, a draw from the reserve it just made.
 */
export function reservation<Ids extends string, Held extends Ids>(
  session: Session,
  reservationId: string,
): Reservation<Ids, Held> {
  assertNonEmpty(reservationId, "reservationId");
  const headers = { [Header.ReservationId]: reservationId };

  return {
    reservationId,

    commit: (amounts, options) =>
      draw<Ids>(session, {
        path: Path.Commit,
        headers,
        ...(amounts === undefined ? undefined : { body: { budgets: corrections(amounts) } }),
        options,
        context: "commit",
        refusable: true,
      }),

    // A release spends nothing, so it cannot come back refused.
    release: (options) =>
      draw<Ids>(session, {
        path: Path.Release,
        headers,
        options,
        context: "release",
        refusable: false,
      }) as Promise<DrawOk<Ids>>,
  };
}

/** The `{ id, amount }` pairs of a correction, checked and stripped of anything left out. */
function corrections(amounts: Amounts<string>): { id: string; amount: number }[] {
  const budgets: { id: string; amount: number }[] = [];
  for (const [id, amount] of Object.entries(amounts)) {
    if (amount === undefined) {
      continue;
    }
    assertAmount(id, amount);
    budgets.push({ id, amount });
  }
  return budgets;
}

export function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

export function budgetsOf(body: unknown): DrawnBudget[] {
  const budgets = (body as Response$ | null)?.budgets;
  if (!Array.isArray(budgets)) {
    throw new HorseHolderError({
      status: null,
      code: "invalid_response",
      message: "response did not carry a budgets array",
      body,
    });
  }
  return budgets as DrawnBudget[];
}

export function assertIdentifier(value: string, subject: string): void {
  if (!ID_PATTERN.test(value)) {
    invalid(`${subject} must match [A-Za-z0-9_.-]{1,128}, got ${JSON.stringify(value)}`);
  }
}

/** A tenant may be the empty string, which a budget id or a group may not. */
export function assertTenant(tenant: string | null): void {
  if (tenant !== null && tenant !== "") {
    assertIdentifier(tenant, "tenant");
  }
}

export function assertNonEmpty(value: string, subject: string): void {
  if (value === "") {
    invalid(`${subject} must not be empty`);
  }
}

export function assertAmount(id: string, amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) {
    invalid(`budget ${JSON.stringify(id)}: amount must be finite and non-negative, ${amount}`);
  }
}
