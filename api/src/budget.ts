/**
 * The `BudgetGroup` Durable Object: one instance per `(scope, tenant, group)` triple.
 *
 * Invokable via DO RPC methods, expecitng a validated IR passed from the Worker.
 *
 * Enables the atomic requirements of Horse Holder.
 */

import { DurableObject } from "cloudflare:workers";
import { nextBoundary, type Renewal } from "./renewal.ts";
import {
  ApiError,
  type BudgetView,
  type DrawnBudgetView,
  Code,
  type CommitEntry,
  type Definition,
  type Draw,
  type DrawEntry,
  Header,
  IDEMPOTENCY_RETENTION_MS,
  type Reply,
} from "./schema.ts";

interface BudgetState {
  limit: number;
  warnings: number[];
  renewal: Renewal;

  /** Usage in the current period, *including* capacity held by open reservations. */
  used: number;

  renewsAt: number | null;

  /** Warning high-water mark: the greatest usage fraction seen this period. */
  hwm: number;

  createdAt: number;
}

interface ReservationState {
  status: "open" | "committed" | "released";
  expiresAt: number;
  amounts: Record<string, number>;

  /** The settling body, replayed verbatim on a repeat commit or release. */
  response?: unknown;

  settledAt?: number;
}

interface IdempotencyRecord {
  /** Budget IDs and amounts only; the definition is excluded from the comparison. */
  fingerprint: string;

  body: unknown;
  recordedAt: number;
}

/** How long a settled reservation is retained so repeat settles can replay it. */
const SETTLED_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * How often expired records are reclaimed from storage.
 *
 * Reclamation is housekeeping, not correctness.
 * Retention is enforced on every request lazily.
 */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class BudgetGroup extends DurableObject<Env> {
  /** Writes staged by the current request, flushed once the reply is decided. */
  private batch = new WriteBatch();

  private budgets = new Store<BudgetState>("b:", this.batch);
  private reservations = new Store<ReservationState>("r:", this.batch);
  private idempotency = new Store<IdempotencyRecord>("i:", this.batch);

  /** Whether a sweep alarm is already pending, so requests need not re-read it. */
  private sweepScheduled = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Load once, then serve every request from memory. Blocking here means no handler ever
    // observes partially-loaded state.
    ctx.blockConcurrencyWhile(async () => {
      const stores = [this.budgets, this.reservations, this.idempotency];
      for (const [key, value] of await ctx.storage.list()) {
        stores.find((store) => store.owns(key))?.load(key, value as never);
      }
      this.sweepScheduled = (await ctx.storage.getAlarm()) !== null;
    });
  }

  /** Reclaims records past their retention. Housekeeping only; see `SWEEP_INTERVAL_MS`. */
  override async alarm(): Promise<void> {
    this.sweepScheduled = false;
    this.sweepExpiredRecords(Date.now());
    await this.batch.flush(this.ctx.storage);
    await this.scheduleSweep();
  }

  charge(draw: Draw): Promise<Reply> {
    return this.run((now) => this.applyDraw(draw, now, null));
  }

  reserve(draw: Draw, ttlSeconds: number): Promise<Reply> {
    return this.run((now) => this.applyDraw(draw, now, ttlSeconds));
  }

  commit(reservationId: string, corrections: CommitEntry[]): Promise<Reply> {
    return this.run((now) => this.applyCommit(reservationId, corrections, now));
  }

  release(reservationId: string): Promise<Reply> {
    return this.run((now) => this.applyRelease(reservationId, now));
  }

  read(budgetId: string): Promise<Reply> {
    return this.run(() => {
      const budget = this.budgets.get(budgetId);

      // 404 here means "never drawn against", since budgets are created lazily.
      if (budget === undefined) {
        const message = `no budget '${budgetId}' in this group`;
        return ApiError.error(404, Code.BudgetNotFound, message).reply();
      }

      // the single-entry array omits `requested`, `exceeded`, and `warningsCrossed`.
      return { status: 200, body: { budgets: [view(budgetId, budget)] } };
    });
  }

  /**
   * The shared preamble and epilogue: expire holds, apply renewals, sweep, then flush.
   */
  private async run(handler: (now: number) => Reply): Promise<Reply> {
    const now = Date.now();

    this.expireHolds(now);
    this.applyRenewals(now);

    const reply = handler(now);

    await this.batch.flush(this.ctx.storage);
    await this.scheduleSweep();
    return reply;
  }

  /** Arms the reclamation alarm, if anything is retained and one is not already pending. */
  private async scheduleSweep(): Promise<void> {
    const retained = this.idempotency.size > 0 || this.reservations.size > 0;
    if (this.sweepScheduled || !retained) {
      return;
    }
    this.sweepScheduled = true;
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }

  /**
   * Applies a "draw": either a charge or reservation, deducting capacity from the budgets.
   */
  private applyDraw({ key, entries }: Draw, now: number, ttlSeconds: number | null): Reply {
    const idempotencyKey = `${ttlSeconds === null ? "charge" : "reserve"}:${key}`;
    const fingerprint = JSON.stringify(
      entries.map((e) => [e.id, e.amount] as const).sort(([a], [b]) => (a < b ? -1 : 1)),
    );

    // A replay past the retention window is treated as a new request. Enforced here
    // rather than by the sweep, so the answer never depends on when housekeeping last ran.
    const replay = this.idempotency.get(idempotencyKey);
    if (replay !== undefined && now - replay.recordedAt <= IDEMPOTENCY_RETENTION_MS) {
      if (replay.fingerprint !== fingerprint) {
        const message = "idempotency-key reused with a different request";
        return ApiError.error(409, Code.IdempotencyConflict, message).reply();
      }

      return { status: 200, body: replay.body };
    }

    // reconciliation happens before the draw is evaluated.
    for (const entry of entries) {
      this.reconcile(entry, now);
    }

    const evaluated = entries.map((entry) => {
      const budget = this.budgets.get(entry.id)!;
      return { entry, budget, exceeded: budget.used + entry.amount > budget.limit };
    });

    if (evaluated.some((e) => e.exceeded)) {
      // A failed draw writes no idempotency record.
      return this.exceededReply(
        // no threshold can have been crossed by a draw that never happened.
        evaluated.map(({ entry, budget, exceeded }) =>
          drawnView(entry.id, budget, { requested: entry.amount, exceeded, warningsCrossed: [] }),
        ),
        now,
      );
    }

    // No `await` between the check above and these writes.
    const budgets = evaluated.map(({ entry, budget }) => {
      budget.used += entry.amount;
      const warningsCrossed = this.crossWarnings(budget);
      this.budgets.set(entry.id, budget);

      return drawnView(entry.id, budget, {
        requested: entry.amount,
        exceeded: false,
        warningsCrossed,
      });
    });

    let body = { budgets } as unknown;
    if (ttlSeconds !== null) {
      const reservationId = `rsv_${randomHex(16)}`;
      const expiresAt = now + ttlSeconds * 1000;
      const reservation = {
        status: "open",
        expiresAt,
        amounts: Object.fromEntries(entries.map((entry) => [entry.id, entry.amount])),
      } satisfies ReservationState;

      this.reservations.set(reservationId, reservation);
      body = { reservationId, expiresAt: new Date(expiresAt).toISOString(), budgets };
    }

    const record = { fingerprint, body, recordedAt: now } satisfies IdempotencyRecord;
    this.idempotency.set(idempotencyKey, record);
    return { status: 200, body };
  }

  /**
   * Apply a commit to a reservation, adjusting the held amounts and the budgets' usage.
   */
  private applyCommit(reservationId: string, corrections: CommitEntry[], now: number): Reply {
    const reservation = this.reservations.get(reservationId);

    // unknown *or expired* is 404 (expiry already returned the capacity).
    if (reservation === undefined) {
      return reservationNotFound().reply();
    }

    if (reservation.status === "committed") {
      // Idempotent: replay the original result, ignoring newly submitted amounts.
      return { status: 200, body: reservation.response };
    }

    if (reservation.status === "released") {
      return settled("reservation was already released").reply();
    }

    const amounts = { ...reservation.amounts };
    for (const correction of corrections) {
      // A commit MUST NOT introduce a budget absent from the reservation.
      if (!(correction.id in reservation.amounts)) {
        return ApiError.invalid(
          `budget '${correction.id}' was not part of this reservation`,
        ).reply();
      }
      amounts[correction.id] = correction.amount;
    }

    const evaluated = Object.entries(reservation.amounts).map(([id, held]) => {
      const budget = this.budgets.get(id)!;
      const delta = amounts[id]! - held;
      return {
        id,
        budget,
        delta,
        requested: amounts[id]!,
        // The hold already sits inside `used`, so only an increase is a fresh draw.
        exceeded: delta > 0 && budget.used + delta > budget.limit,
      };
    });

    // Every increase is evaluated before anything is applied: if one lacks capacity the whole
    // commit fails and the reservation stays open and unchanged.
    if (evaluated.some((e) => e.exceeded)) {
      return this.exceededReply(
        evaluated.map((e) =>
          drawnView(e.id, e.budget, {
            requested: e.requested,
            exceeded: e.exceeded,
            warningsCrossed: [],
          }),
        ),
        now,
      );
    }

    const budgets = evaluated.map((e) => {
      e.budget.used = Math.max(0, e.budget.used + e.delta);
      // warnings are computed on a successful draw *or commit*.
      const warningsCrossed = this.crossWarnings(e.budget);
      this.budgets.set(e.id, e.budget);
      return drawnView(e.id, e.budget, {
        requested: e.requested,
        exceeded: false,
        warningsCrossed,
      });
    });
    return this.settleWith(reservationId, reservation, "committed", budgets, now);
  }

  private applyRelease(reservationId: string, now: number): Reply {
    const reservation = this.reservations.get(reservationId);
    if (reservation === undefined) {
      return reservationNotFound().reply();
    }
    if (reservation.status === "released") {
      return { status: 200, body: reservation.response };
    }
    if (reservation.status === "committed") {
      return settled("reservation was already committed").reply();
    }

    const budgets = Object.entries(reservation.amounts).map(([id, amount]) => {
      const budget = this.budgets.get(id)!;
      budget.used = Math.max(0, budget.used - amount);

      // the high-water mark is not lowered by returned capacity.
      this.budgets.set(id, budget);

      // nothing is drawn by a release, so `requested` is 0 and no threshold is crossed.
      return drawnView(id, budget, { requested: 0, exceeded: false, warningsCrossed: [] });
    });
    return this.settleWith(reservationId, reservation, "released", budgets, now);
  }

  /**
   * An expired reservation returns its held capacity.
   *
   * This can be done lazily, on next access, rather than with a timer.
   */
  private expireHolds(now: number): void {
    for (const [id, reservation] of this.reservations) {
      if (reservation.status !== "open" || now < reservation.expiresAt) {
        continue;
      }

      for (const [budgetId, amount] of Object.entries(reservation.amounts)) {
        const budget = this.budgets.get(budgetId);
        if (budget !== undefined) {
          budget.used = Math.max(0, budget.used - amount);
          this.budgets.set(budgetId, budget);
        }
      }

      this.reservations.delete(id);
    }
  }

  /**
   * Renewal is evaluated lazily, at the start of any request touching the budget.
   *
   * No background job is required, and a budget nobody touches need never be advanced.
   */
  private applyRenewals(now: number): void {
    for (const [id, budget] of this.budgets) {
      if (budget.renewsAt === null || now < budget.renewsAt) {
        continue;
      }
      let boundary: number | null = budget.renewsAt;
      while (boundary !== null && now >= boundary) {
        boundary = nextBoundary(budget.renewal, boundary, budget.createdAt);
      }
      budget.renewsAt = boundary;

      // usage resets to the sum of amounts held by open reservations, not to zero.
      budget.used = this.heldFor(id);

      // the high-water mark resets on renewal.
      budget.hwm = 0;

      this.budgets.set(id, budget);
    }
  }

  /** Discards idempotency records and settled reservations past their retention. */
  private sweepExpiredRecords(now: number): void {
    for (const [key, record] of this.idempotency) {
      if (now - record.recordedAt > IDEMPOTENCY_RETENTION_MS) {
        this.idempotency.delete(key);
      }
    }

    for (const [id, { settledAt }] of this.reservations) {
      if (settledAt !== undefined && now - settledAt > SETTLED_RETENTION_MS) {
        this.reservations.delete(id);
      }
    }
  }

  /** Total capacity held by open reservations against one budget. */
  private heldFor(budgetId: string): number {
    let total = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.status === "open") {
        total += reservation.amounts[budgetId] ?? 0;
      }
    }
    return total;
  }

  /**
   * Reconciles a submitted definition onto stored state.
   *
   * Usage is preserved across every change. That is the rule that makes last-write-wins drift safe
   * and keeps limits from being bypassable by nudging them.
   */
  private reconcile({ id, definition }: DrawEntry, now: number): void {
    const budget = this.budgets.get(id) ?? this.create(id, definition, now);
    // a limit change resets the high-water mark, because thresholds are fractions of
    // the limit and would otherwise silently suppress legitimately-breached warnings.
    if (budget.limit !== definition.limit) {
      budget.limit = definition.limit;
      budget.hwm = 0;
    }
    // a warnings-only change must NOT reset the mark.
    budget.warnings = definition.warnings;

    // a renewal change recomputes the next boundary from *now*, never refunding usage.
    if (JSON.stringify(budget.renewal) !== JSON.stringify(definition.renewal)) {
      budget.renewal = definition.renewal;
      budget.renewsAt = nextBoundary(definition.renewal, now, budget.createdAt);
    }
    this.budgets.set(id, budget);
  }

  /** a draw against a budget that does not yet exist creates it from its definition. */
  private create(id: string, definition: Definition, now: number): BudgetState {
    const budget = {
      limit: definition.limit,
      warnings: definition.warnings,
      renewal: definition.renewal,
      used: 0,
      renewsAt: nextBoundary(definition.renewal, now, now),
      hwm: 0,
      createdAt: now,
    } satisfies BudgetState;

    this.budgets.set(id, budget);
    return budget;
  }

  /**
   * Computes `warningsCrossed` and advances the high-water mark.
   *
   * Reports every threshold above the previous mark and at or below the new fraction, in
   * ascending order. A single large draw may cross several at once.
   */
  private crossWarnings(budget: BudgetState): number[] {
    const fraction = budget.used / budget.limit;
    const crossed = budget.warnings.filter((w) => w > budget.hwm && w <= fraction);

    // Monotonic: never lowered by a release or a downward commit.
    budget.hwm = Math.max(budget.hwm, fraction);
    return crossed;
  }

  /** Marks a reservation terminal, storing the body a repeat settle replays. */
  private settleWith(
    id: string,
    reservation: ReservationState,
    status: "committed" | "released",
    budgets: DrawnBudgetView[],
    now: number,
  ): Reply {
    reservation.status = status;
    reservation.response = { budgets };
    reservation.settledAt = now;
    this.reservations.set(id, reservation);
    return { status: 200, body: reservation.response };
  }

  /**
   * `402`: the same array shape and ordering as a `200`, covering every requested
   * budget, with pre-draw `used`/`remaining` because nothing was applied.
   */
  private exceededReply(views: DrawnBudgetView[], now: number): Reply {
    const failed = views.filter((v) => v.exceeded);
    // `retry-after` is the seconds until the earliest renewal among exceeded budgets,
    // omitted when every one of them is `never`, since no amount of waiting would help.
    const boundaries = failed
      .map((v) => v.renewsAt)
      .filter((renewsAt): renewsAt is string => renewsAt !== null)
      .map((renewsAt) => Date.parse(renewsAt));

    const retryAfter = String(Math.max(0, Math.ceil((Math.min(...boundaries) - now) / 1000)));
    const message = `${failed.length} of ${views.length} budgets lacked capacity`;

    return ApiError.error(402, Code.BudgetExceeded, message).reply(
      { budgets: views },
      boundaries.length === 0 ? undefined : { [Header.RetryAfter]: retryAfter },
    );
  }
}

/** Accumulates one request's writes and deletes across every `Store` sharing it. */
class WriteBatch {
  private writes = new Map<string, unknown>();
  private deletes = new Set<string>();

  put(key: string, value: unknown): void {
    this.writes.set(key, value);
    this.deletes.delete(key);
  }

  drop(key: string): void {
    this.writes.delete(key);
    this.deletes.add(key);
  }

  /** Persists everything staged so far, as one batch. */
  async flush(storage: DurableObjectStorage): Promise<void> {
    const writes = this.writes;
    const deletes = this.deletes;
    this.writes = new Map();
    this.deletes = new Set();
    if (writes.size > 0) {
      await storage.put(Object.fromEntries(writes));
    }
    if (deletes.size > 0) {
      await storage.delete([...deletes]);
    }
  }
}

/**
 * One kind of record, namespaced under `prefix`, held in memory and written behind.
 *
 * `set` and `delete` update the map *and* stage the persistence together, so a mutation that
 * never reaches storage is unrepresentable. Because staging is synchronous, no handler needs
 * an `await` between a capacity check and the update that follows it.
 */
class Store<T> {
  private records = new Map<string, T>();

  constructor(
    private readonly prefix: string,
    private readonly batch: WriteBatch,
  ) {}

  /** True when `key` belongs to this store, used to route records at load time. */
  owns(key: string): boolean {
    return key.startsWith(this.prefix);
  }

  /** Adopts a record read from storage, without staging it for write-back. */
  load(key: string, value: T): void {
    this.records.set(key.slice(this.prefix.length), value);
  }

  get(name: string): T | undefined {
    return this.records.get(name);
  }

  set(name: string, value: T): void {
    this.records.set(name, value);
    this.batch.put(this.prefix + name, value);
  }

  delete(name: string): void {
    this.records.delete(name);
    this.batch.drop(this.prefix + name);
  }

  get size(): number {
    return this.records.size;
  }

  values(): IterableIterator<T> {
    return this.records.values();
  }

  [Symbol.iterator](): IterableIterator<[string, T]> {
    return this.records[Symbol.iterator]();
  }
}

/** The state half of a `budgets` entry: all a read reports. */
function view(id: string, budget: BudgetState): BudgetView {
  return {
    id,
    limit: budget.limit,
    used: budget.used,
    remaining: Math.max(0, budget.limit - budget.used),
    renewsAt: budget.renewsAt === null ? null : new Date(budget.renewsAt).toISOString(),
  };
}

/** A `budgets` entry on a draw or settlement, in the field order. */
function drawnView(
  id: string,
  budget: BudgetState,
  outcome: { requested: number; exceeded: boolean; warningsCrossed: number[] },
): DrawnBudgetView {
  const { limit, used, remaining, renewsAt } = view(id, budget);
  return {
    id,
    requested: outcome.requested,
    exceeded: outcome.exceeded,
    limit,
    used,
    remaining,
    renewsAt,
    warningsCrossed: outcome.warningsCrossed,
  };
}

function reservationNotFound(): ApiError {
  return ApiError.error(404, Code.ReservationNotFound, "unknown or expired reservation");
}

function settled(message: string): ApiError {
  return ApiError.error(409, Code.ReservationSettled, message);
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
}
