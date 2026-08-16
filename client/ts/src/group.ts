/**
 * A group of budgets, and everything you can do with them.
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
  type BudgetsSpec,
  type DrawEntry,
  type DrawFailed,
  type DrawOk,
  type DrawOptions,
  type DrawResult,
  type DrawnBudget,
  type GroupSpec,
  type GroupState,
  ID_PATTERN,
  MAX_BUDGETS_PER_DRAW,
  type RequestOptions,
  type ReserveOptions,
  type ReserveResult,
  type Response$,
  type SettleOptions,
  type WarningCrossing,
} from "./types.ts";

const Path = {
  Budget: "/v1/budget",
  Charge: "/v1/charge",
  Commit: "/v1/commit",
  Release: "/v1/release",
  Reserve: "/v1/reserve",
} as const;

/** Called when a draw pushes a budget past one of its warning thresholds. */
export type WarningHandler = (warning: {
  /** The group the budget belongs to. */
  group: string;
  /** Which of your end users this was for, or `null` for no tenant. */
  tenant: string | null;
  /** The budget that crossed. Same as `budget.id`, up here because it is what you want. */
  id: string;
  /** What it crossed, smallest first. Same as `budget.warningsCrossed`. */
  thresholds: readonly number[];
  /**
   * The budget as it stands after the draw, so you can say how bad it is rather than only
   * which line was passed: `used`, `limit`, `remaining`, and `renewsAt` are all here.
   */
  budget: BudgetOutcome;
}) => void;

/**
 * A group of budgets, and everything you can do with them.
 *
 * A group is the unit here rather than an individual budget, because the server treats it that
 * way: budgets in one group can be spent together in a single all-or-nothing operation, and
 * budgets in different groups cannot be combined at all. So you declare the group and then draw
 * from its members.
 *
 * Put budgets together when a single operation spends from both of them at once, like an upload
 * that costs one write and some bytes. Keep unrelated things apart, like your email quota and
 * your storage quota, since separate groups can be drawn at the same time without waiting on
 * each other.
 *
 * One thing to be careful about: the group name is part of each budget's identity. Renaming the
 * group does not move your budgets, it silently starts new ones at zero. Pick a name and keep
 * it.
 */
export class BudgetGroup<B extends BudgetsSpec> {
  /** The group name. */
  readonly id: string;

  /** The budgets you declared. */
  readonly budgets: B;

  /**
   * The request payload for each budget, built once here rather than on every draw.
   *
   * A definition is exactly the spec the caller already handed us, and both are immutable, so
   * a draw serializes what it was given instead of rebuilding it.
   */
  private readonly definitions: B;

  constructor(
    spec: GroupSpec<B>,
    private readonly transport: Transport,
    private readonly boundTenant: string | null,
    private readonly onWarning: WarningHandler | undefined,
  ) {
    this.id = spec.id;
    this.budgets = spec.budgets;
    this.definitions = spec.budgets;
  }

  /**
   * The same group, for a different one of your end users.
   *
   * ```ts
   * const acme = r2.tenant("acme");
   * const globex = r2.tenant("globex");
   * ```
   *
   * Each gets its own separate copy of every budget in the group. They share one HTTP
   * connection and one declaration. Pass `null` for no tenant, or `""` for the tenant whose
   * name is the empty string, which is a different budget again.
   */
  tenant(id: string | null): BudgetGroup<B> {
    assertTenant(id);
    return new BudgetGroup(this, this.transport, id, this.onWarning);
  }

  /**
   * Spend from one or more budgets right now.
   *
   * Use this when you know the cost before you do the work. If any budget is short, nothing is
   * spent from any of them and you get `ok: false` rather than an exception.
   *
   * ```ts
   * const result = await r2.charge(
   *   { "put-ops": 1, "storage-bytes": 4096 },
   *   { idempotencyKey: `upload-${uploadId}` },
   * );
   *
   * if (!result.ok) {
   *   console.warn("no room in", result.exceeded.map((b) => b.id).join(", "));
   *   return;
   * }
   *
   * await uploadTheFile();
   * console.log(`${result.get("put-ops").remaining} writes left today`);
   * ```
   */
  async charge(amounts: Amounts<B>, options: DrawOptions): Promise<DrawResult<B>> {
    const { result, tenant } = await this.draw(Path.Charge, amounts, options);
    if (result.status !== 200 && result.status !== 402) {
      throw toError(result, "charge");
    }
    return this.decodeDraw(result, tenant);
  }

  /**
   * Hold capacity now, settle up once you know what it actually cost.
   *
   * The held amount counts as spent immediately, so nothing else can take it while you work.
   * Then `commit` it, correcting the numbers if your estimate was off, or `release` it if the
   * operation never happened.
   *
   * ```ts
   * const lease = await r2.reserve(
   *   { "storage-bytes": 10_000 },
   *   { idempotencyKey: `upload-${uploadId}`, ttlSeconds: 60 },
   * );
   * if (!lease.ok) return;
   *
   * try {
   *   const written = await uploadTheFile();
   *   await lease.commit({ "storage-bytes": written });
   * } catch (error) {
   *   await lease.release();
   *   throw error;
   * }
   * ```
   *
   * The lease remembers which budgets it held, so `commit` will not accept a correction naming
   * one it did not. If you forget to settle, the hold expires on its own and the capacity
   * comes back.
   */
  async reserve<const A extends Amounts<B>>(
    amounts: A,
    options: ReserveOptions,
  ): Promise<ReserveResult<B, keyof A & string>> {
    const { result, tenant } = await this.draw(Path.Reserve, amounts, options);
    if (result.status !== 200 && result.status !== 402) {
      throw toError(result, "reserve");
    }

    const draw = this.decodeDraw(result, tenant);
    if (!draw.ok) {
      return draw;
    }

    const { reservationId, expiresAt } = result.body as Response$;
    if (reservationId === undefined || expiresAt === undefined) {
      throw new HorseHolderError({
        status: null,
        code: "invalid_response",
        message: "reserve succeeded without a reservationId and expiresAt",
        body: result.body,
      });
    }

    return {
      ...draw,
      reservationId,
      expiresAt: new Date(expiresAt),
      commit: (corrections, settleOptions) =>
        this.commit(reservationId, corrections as Amounts<B> | undefined, settleOptions),
      release: (settleOptions) => this.release(reservationId, settleOptions),
    };
  }

  /**
   * Settle a reservation by its id.
   *
   * `Lease.commit` is nicer and is what you want when you still have the lease in hand. Use
   * this one when the work finished somewhere else and all you carried over was the id.
   *
   * ```ts
   * await r2.commit(reservationId, { "storage-bytes": actualBytes });
   * ```
   *
   * Throws if the hold already expired or was already released, since both mean your code lost
   * track of something rather than that a budget ran out.
   */
  async commit(
    reservationId: string,
    corrections?: Amounts<B>,
    options?: SettleOptions,
  ): Promise<DrawResult<B>> {
    assertNonEmpty(reservationId, "reservationId");
    const tenant = this.tenantFor(options);
    const result = await this.transport.send({
      path: Path.Commit,
      method: "POST",
      group: this.id,
      tenant,
      headers: { [Header.ReservationId]: reservationId },
      ...(corrections === undefined ? undefined : { body: { budgets: entries(corrections) } }),
      options: options ?? {},
    });

    if (result.status !== 200 && result.status !== 402) {
      throw toError(result, "commit");
    }
    return this.decodeDraw(result, tenant);
  }

  /**
   * Give a reservation's capacity back without spending it.
   *
   * Releasing something already released is fine, so this is safe to call from a `catch`.
   */
  async release(reservationId: string, options?: SettleOptions): Promise<DrawOk<B>> {
    assertNonEmpty(reservationId, "reservationId");
    const tenant = this.tenantFor(options);
    const result = await this.transport.send({
      path: Path.Release,
      method: "POST",
      group: this.id,
      tenant,
      headers: { [Header.ReservationId]: reservationId },
      options: options ?? {},
    });

    if (result.status !== 200) {
      throw toError(result, "release");
    }
    // A release spends nothing, so it cannot come back refused.
    return this.decodeDraw(result, tenant) as DrawOk<B>;
  }

  /**
   * Read the current state of every budget in the group, without spending anything.
   *
   * One request gets you the whole group, and every number in it describes the same moment, so
   * you never see a multi-budget spend applied to some of them and not the others.
   *
   * ```ts
   * const state = await r2.read();
   * for (const budget of state.budgets) {
   *   console.log(`${budget.id}: ${budget.used}/${budget.limit}`);
   * }
   *
   * state.get("put-ops")?.remaining;  // undefined if never drawn against
   * ```
   *
   * Budgets you have declared but never actually drawn from are not in the result, since they
   * do not exist on the server until something spends from them. A brand new group reads back
   * empty.
   */
  async read(options?: RequestOptions): Promise<GroupState<B>> {
    const result = await this.transport.send({
      path: Path.Budget,
      method: "GET",
      group: this.id,
      tenant: this.tenantFor(options),
      headers: {},
      options: options ?? {},
    });

    if (result.status !== 200) {
      throw toError(result, "read");
    }

    const budgets = budgetsOf(result.body).map((wire) => ({
      id: wire.id,
      limit: wire.limit,
      used: wire.used,
      remaining: wire.remaining,
      renewsAt: toDate(wire.renewsAt),
    }));

    return {
      budgets,
      get: (id) => budgets.find((budget) => budget.id === id),
      raw: result.body,
    };
  }

  /** Left out means inherit; `null` and `""` mean exactly themselves. */
  private tenantFor(options: RequestOptions | undefined): string | null {
    if (options?.tenant === undefined) {
      return this.boundTenant;
    }
    assertTenant(options.tenant);
    return options.tenant;
  }

  private async draw(
    path: string,
    amounts: Amounts<B>,
    options: ReserveOptions,
  ): Promise<{ result: WireResult; tenant: string | null }> {
    assertNonEmpty(options.idempotencyKey, "idempotencyKey");

    const budgets: DrawEntry[] = [];
    for (const [id, amount] of Object.entries(amounts)) {
      if (amount === undefined) {
        continue;
      }
      const definition = this.definitions[id];
      if (definition === undefined) {
        // Types rule this out, but plain JavaScript callers land here instead of at the server.
        invalid(`budget ${JSON.stringify(id)} is not declared in group ${JSON.stringify(this.id)}`);
      }
      if (!Number.isFinite(amount) || amount < 0) {
        invalid(`budget ${JSON.stringify(id)}: amount must be finite and non-negative, ${amount}`);
      }
      budgets.push({ id, amount, definition });
    }
    if (budgets.length < 1 || budgets.length > MAX_BUDGETS_PER_DRAW) {
      invalid(`a draw must name 1 to ${MAX_BUDGETS_PER_DRAW} budgets, got ${budgets.length}`);
    }

    const tenant = this.tenantFor(options);
    const result = await this.transport.send({
      path,
      method: "POST",
      group: this.id,
      tenant,
      headers: {
        [Header.IdempotencyKey]: options.idempotencyKey,
        ...(options.ttlSeconds === undefined
          ? undefined
          : { [Header.TtlSeconds]: String(options.ttlSeconds) }),
      },
      body: { budgets },
      options,
    });
    return { result, tenant };
  }

  private decodeDraw(result: WireResult, tenant: string | null): DrawResult<B> {
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

    const get = (id: keyof B & string): BudgetOutcome => {
      const found = outcomes.find((outcome) => outcome.id === id);
      if (found !== undefined) {
        return found;
      }

      // A budget you declared but have never drawn from does not exist on the server yet, so it
      // is missing from the response. Its state is still known: nothing spent, everything
      // remaining. Reporting that beats handing back undefined for a budget the caller can see
      // in its own group.
      const spec = this.budgets[id];
      if (spec === undefined) {
        invalid(`budget ${JSON.stringify(id)} is not declared in group ${JSON.stringify(this.id)}`);
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
      } satisfies DrawFailed<B>;
    }

    // One pass, and no array at all on the overwhelmingly common path where nothing crossed.
    let warningsCrossed: WarningCrossing<keyof B & string>[] = EMPTY_WARNINGS;
    for (const outcome of outcomes) {
      if (outcome.warningsCrossed.length === 0) {
        continue;
      }
      if (warningsCrossed === EMPTY_WARNINGS) {
        warningsCrossed = [];
      }
      warningsCrossed.push({
        id: outcome.id as keyof B & string,
        thresholds: outcome.warningsCrossed,
      });
      this.onWarning?.({
        group: this.id,
        tenant,
        id: outcome.id,
        thresholds: outcome.warningsCrossed,
        budget: outcome,
      });
    }

    return { ok: true, budgets: outcomes, warningsCrossed, get, raw: result.body };
  }
}

const EMPTY_WARNINGS: WarningCrossing<never>[] = [];

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function entries(amounts: Record<string, number | undefined>): { id: string; amount: number }[] {
  const budgets: { id: string; amount: number }[] = [];
  for (const [id, amount] of Object.entries(amounts)) {
    if (amount === undefined) {
      continue;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      invalid(`budget ${JSON.stringify(id)}: amount must be finite and non-negative, ${amount}`);
    }
    budgets.push({ id, amount });
  }
  return budgets;
}

function budgetsOf(body: unknown): DrawnBudget[] {
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

function assertNonEmpty(value: string, subject: string): void {
  if (value === "") {
    invalid(`${subject} must not be empty`);
  }
}
