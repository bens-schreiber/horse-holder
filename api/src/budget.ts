/**
 * The `BudgetGroup` Durable Object: one instance per `(scope, tenant, group)` triple.
 *
 * Invoked by RPC from the Worker, which has already validated everything it passes.
 *
 * Being one object per atomicity domain is what makes the all-or-nothing guarantee
 * structural: a draw cannot span two of these, and within one there is no concurrency to
 * lose a check-and-decrement to.
 */

import { DurableObject } from "cloudflare:workers";
import { ExpiryQueue } from "./expiry.ts";
import { type Renewal, nextBoundary, renewalKey } from "./renewal.ts";
import {
  ApiError,
  type BudgetView,
  Code,
  type CommitEntry,
  type Definition,
  type Draw,
  type DrawEntry,
  type DrawnBudgetView,
  Header,
  IDEMPOTENCY_RETENTION_MS,
  type Outcome,
  type Reply,
} from "./schema.ts";

/** The outcome carried by a budget this request never named. */
const UNTOUCHED: Outcome = { requested: 0, exceeded: false, warningsCrossed: [] };

/**
 * What a draw does with the capacity it takes: spends it, or holds it for `ttlSeconds`.
 *
 * The two are one operation apart from this, so they share `#applyDraw` and differ only where
 * they read the discriminant.
 */
type Hold = { kind: "charge" } | { kind: "reserve"; ttlSeconds: number };

/**
 * Charge and reserve keep separate idempotency namespaces, so the same key on each is two
 * unrelated operations rather than a conflict.
 */
function idempotencyKey(hold: Hold, key: string): string {
  return `${hold.kind}:${key}`;
}

/** How long a settled reservation is retained so repeat settles can replay it. */
const SETTLED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** How often idempotency records are scanned for reclamation. See `LazyStore.reclaim`. */
const SCAN_INTERVAL_MS = 60 * 1000;

/** How many idempotency records one scan may reclaim, so a backlog drains over several. */
const SCAN_BATCH = 256;

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

  /**
   * The response as first produced, replayed verbatim. Its `budgets` array is a snapshot of
   * the group at that instant, so a replay does not pick up budgets the group has gained
   * since.
   */
  body: unknown;

  recordedAt: number;
}

export class BudgetGroup extends DurableObject<Env> {
  /** Writes staged by the current request, flushed once the reply is decided. */
  private batch = new WriteBatch();

  private budgets = new Store<BudgetState>("b:", this.batch);
  private reservations = new Store<ReservationState>("r:", this.batch);

  /**
   * Idempotency records, read through to storage rather than held in memory.
   *
   * A day of records on a busy group is far more data than the budgets themselves, it is
   * looked up only by exact key, and loading it would put cold-start latency on a curve set
   * by traffic instead of by how many budgets the group has.
   */
  private idempotency: LazyStore<IdempotencyRecord>;

  /** Open holds by expiry, so returning lapsed capacity costs what it returns. */
  private holds = new ExpiryQueue<string>();

  /** Settled reservations by reclamation deadline. */
  private settled = new ExpiryQueue<string>();

  /** Budgets by renewal boundary, so a request advances only the periods that have ended. */
  private renewals = new ExpiryQueue<string>();

  /**
   * Budget ids in the lexicographic order every response body uses, or `null` when a budget
   * has been created since the last render and the order needs rebuilding.
   */
  private order: string[] | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.idempotency = new LazyStore("i:", "x:", this.batch, ctx.storage);

    // Load the working set once, then serve every request from memory. Blocking here means no
    // handler ever observes partially-loaded state.
    ctx.blockConcurrencyWhile(async () => {
      for (const [key, value] of await ctx.storage.list({ start: "b:", end: "c:" })) {
        this.budgets.load(key, value as BudgetState);
      }
      for (const [key, value] of await ctx.storage.list({ start: "r:", end: "s:" })) {
        this.reservations.load(key, value as ReservationState);
      }
      this.reindex();
    });
  }

  async charge(draw: Draw): Promise<Reply> {
    const hold = { kind: "charge" } as const;
    await this.idempotency.prime(idempotencyKey(hold, draw.key));
    return this.run((now) => this.applyDraw(draw, hold, now));
  }

  async reserve(draw: Draw, ttlSeconds: number): Promise<Reply> {
    const hold = { kind: "reserve", ttlSeconds } as const;
    await this.idempotency.prime(idempotencyKey(hold, draw.key));
    return this.run((now) => this.applyDraw(draw, hold, now));
  }

  commit(reservationId: string, corrections: CommitEntry[]): Promise<Reply> {
    return this.run((now) => this.applyCommit(reservationId, corrections, now));
  }

  release(reservationId: string): Promise<Reply> {
    return this.run((now) => this.applyRelease(reservationId, now));
  }

  read(): Promise<Reply> {
    // A read is the whole group with no outcome to report. An empty group is not an error:
    // budgets are created lazily on first draw, so it just means nothing has been spent yet.
    return this.run(() => ({
      status: 200,
      body: { budgets: this.ordered().map((id) => view(id, this.budgets.get(id)!)) },
    }));
  }

  /**
   * The shared preamble and epilogue: bring state up to `now`, run the handler, then flush.
   *
   * Everything time-driven happens here rather than on a timer. Holds lapse, periods roll
   * over, and retained records are reclaimed, all as a consequence of somebody asking a
   * question, and all off queues keyed by deadline so an idle group costs nothing and a busy
   * one pays only for what actually came due.
   */
  private async run(handler: (now: number) => Reply): Promise<Reply> {
    const now = Date.now();

    this.expireHolds(now);
    this.applyRenewals(now);
    await this.reclaim(now);

    const reply = handler(now);

    await this.batch.flush(this.ctx.storage);
    return reply;
  }

  /** Rebuilds the deadline queues and the render order from the loaded records. */
  private reindex(): void {
    for (const [id, reservation] of this.reservations) {
      if (reservation.status === "open") {
        this.holds.push(reservation.expiresAt, id);
      } else if (reservation.settledAt !== undefined) {
        this.settled.push(reservation.settledAt + SETTLED_RETENTION_MS, id);
      }
    }
    for (const [id, budget] of this.budgets) {
      if (budget.renewsAt !== null) {
        this.renewals.push(budget.renewsAt, id);
      }
    }
  }

  /** The group's budget ids, lexicographic: the ordering every response body uses. */
  private ordered(): string[] {
    this.order ??= [...this.budgets.keys()].sort(compareIds);
    return this.order;
  }

  /**
   * The whole group, each entry annotated with what this request did to it.
   *
   * Every `budgets` array a draw or settlement produces is built from this. A response
   * describes the atomicity domain at one instant, and the operation is an annotation on that
   * picture rather than the thing being reported, so budgets the request never named are not
   * absent. They are present carrying `UNTOUCHED`.
   *
   * Callers pass what they know (their outcomes); they cannot forget to report the rest.
   */
  private groupView(outcomes: Map<string, Outcome>): DrawnBudgetView[] {
    return this.ordered().map((id) =>
      drawnView(id, this.budgets.get(id)!, outcomes.get(id) ?? UNTOUCHED),
    );
  }

  /** Applies a draw, either a charge or a reservation, deducting capacity from the budgets. */
  private applyDraw({ key, entries }: Draw, hold: Hold, now: number): Reply {
    const recordKey = idempotencyKey(hold, key);
    const fingerprint = JSON.stringify(
      entries
        .map((entry) => [entry.id, entry.amount] as const)
        .sort(([a], [b]) => compareIds(a, b)),
    );

    // A replay past the retention window is treated as a new request. Enforced here rather
    // than by reclamation, so the answer never depends on when housekeeping last ran.
    const replay = this.idempotency.get(recordKey);
    if (replay !== undefined && now - replay.recordedAt <= IDEMPOTENCY_RETENTION_MS) {
      if (replay.fingerprint !== fingerprint) {
        const message = "idempotency-key reused with a different request";
        return ApiError.error(409, Code.IdempotencyConflict, message).reply();
      }
      return { status: 200, body: replay.body };
    }

    // Reconciliation happens before the draw is evaluated, so a definition lands even when the
    // draw it arrived on is refused.
    for (const entry of entries) {
      this.reconcile(entry, now);
    }

    const evaluated = entries.map((entry) => {
      const budget = this.budgets.get(entry.id)!;
      return { entry, budget, exceeded: budget.used + entry.amount > budget.limit };
    });

    if (evaluated.some((e) => e.exceeded)) {
      // A failed draw writes no idempotency record, and no threshold can have been crossed by
      // a draw that never happened.
      return this.exceededReply(
        new Map(
          evaluated.map(({ entry, exceeded }) => [
            entry.id,
            { requested: entry.amount, exceeded, warningsCrossed: [] },
          ]),
        ),
        now,
      );
    }

    // No `await` between the check above and these writes.
    const outcomes = new Map<string, Outcome>();
    for (const { entry, budget } of evaluated) {
      budget.used += entry.amount;
      const warningsCrossed = this.crossWarnings(budget);
      this.budgets.set(entry.id, budget);
      outcomes.set(entry.id, { requested: entry.amount, exceeded: false, warningsCrossed });
    }

    // Rendered once, after every write: a reservation changes no budget, so both shapes below
    // report the same instant.
    const budgets = this.groupView(outcomes);

    const body = ((): unknown => {
      if (hold.kind === "charge") {
        return { budgets };
      }
      const reservationId = `rsv_${randomHex(16)}`;
      const expiresAt = now + hold.ttlSeconds * 1000;
      this.reservations.set(reservationId, {
        status: "open",
        expiresAt,
        amounts: Object.fromEntries(entries.map((entry) => [entry.id, entry.amount])),
      });
      this.holds.push(expiresAt, reservationId);
      return { reservationId, expiresAt: new Date(expiresAt).toISOString(), budgets };
    })();

    this.idempotency.set(recordKey, { fingerprint, body, recordedAt: now });
    return { status: 200, body };
  }

  /** Finalizes a reservation, adjusting the held amounts and the budgets' usage. */
  private applyCommit(reservationId: string, corrections: CommitEntry[], now: number): Reply {
    const reservation = this.reservations.get(reservationId);

    // Unknown *or expired* is 404: expiry already returned the capacity.
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
      // A commit may not introduce a budget absent from the reservation.
      if (!(correction.id in reservation.amounts)) {
        const message = `budget '${correction.id}' was not part of this reservation`;
        return ApiError.invalid(message).reply();
      }
      amounts[correction.id] = correction.amount;
    }

    const evaluated = Object.entries(reservation.amounts).map(([id, held]) => {
      const budget = this.budgets.get(id)!;
      const requested = amounts[id]!;
      const delta = requested - held;
      return {
        id,
        budget,
        delta,
        requested,
        // The hold already sits inside `used`, so only an increase is a fresh draw.
        exceeded: delta > 0 && budget.used + delta > budget.limit,
      };
    });

    // Every increase is evaluated before anything is applied: if one lacks capacity the whole
    // commit fails and the reservation stays open and unchanged.
    if (evaluated.some((e) => e.exceeded)) {
      return this.exceededReply(
        new Map(
          evaluated.map((e) => [
            e.id,
            { requested: e.requested, exceeded: e.exceeded, warningsCrossed: [] },
          ]),
        ),
        now,
      );
    }

    const outcomes = new Map<string, Outcome>();
    for (const { id, budget, delta, requested } of evaluated) {
      budget.used = Math.max(0, budget.used + delta);
      // Warnings are computed on a successful draw *or commit*.
      const warningsCrossed = this.crossWarnings(budget);
      this.budgets.set(id, budget);
      outcomes.set(id, { requested, exceeded: false, warningsCrossed });
    }
    return this.settleWith(reservationId, reservation, "committed", outcomes, now);
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

    for (const [id, amount] of Object.entries(reservation.amounts)) {
      const budget = this.budgets.get(id)!;
      // The high-water mark is not lowered by returned capacity.
      budget.used = Math.max(0, budget.used - amount);
      this.budgets.set(id, budget);
    }

    // A release draws nothing, so it has no outcome to report on any budget, not even the ones
    // it just returned capacity to, which report `requested: 0` like everything else. Its body
    // is the group's post-release state and nothing more.
    return this.settleWith(reservationId, reservation, "released", new Map(), now);
  }

  /**
   * Returns the capacity held by every reservation that has now lapsed.
   *
   * Driven off the hold queue, so this touches the reservations that expired and no others.
   */
  private expireHolds(now: number): void {
    for (const id of this.holds.drain(now)) {
      const reservation = this.reservations.get(id);
      // A hold settled before it lapsed leaves its queue entry behind. Nothing to return.
      if (reservation?.status !== "open") {
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
   * Rolls over every budget whose period has ended.
   *
   * Driven off the renewal queue, so a request that crosses no boundary does no work and a
   * budget nobody touches need never be advanced.
   */
  private applyRenewals(now: number): void {
    for (const id of this.renewals.drain(now)) {
      const budget = this.budgets.get(id);
      // A budget deleted or switched to `never` leaves its queue entry behind.
      if (budget === undefined || budget.renewsAt === null || now < budget.renewsAt) {
        continue;
      }

      let boundary: number | null = budget.renewsAt;
      while (boundary !== null && now >= boundary) {
        boundary = nextBoundary(budget.renewal, boundary, budget.createdAt);
      }
      budget.renewsAt = boundary;
      if (boundary !== null) {
        this.renewals.push(boundary, id);
      }

      // Usage resets to the sum of amounts held by open reservations, not to zero, and the
      // high-water mark resets with it.
      budget.used = this.heldFor(id);
      budget.hwm = 0;
      this.budgets.set(id, budget);
    }
  }

  /** Discards idempotency records and settled reservations past their retention. */
  private async reclaim(now: number): Promise<void> {
    for (const id of this.settled.drain(now)) {
      if (this.reservations.get(id)?.settledAt !== undefined) {
        this.reservations.delete(id);
      }
    }
    await this.idempotency.reclaim(now);
  }

  /**
   * Total capacity held by open reservations against one budget.
   *
   * Only reached on a renewal, which is rare enough that scanning beats indexing every hold by
   * the budgets it names.
   */
  private heldFor(budgetId: string): number {
    let total = 0;
    for (const [, reservation] of this.reservations) {
      if (reservation.status === "open") {
        total += reservation.amounts[budgetId] ?? 0;
      }
    }
    return total;
  }

  /**
   * Reconciles a submitted definition onto stored state.
   *
   * Usage is preserved across every change. That is the rule that makes last-write-wins drift
   * safe and keeps limits from being bypassable by nudging them.
   */
  private reconcile({ id, definition }: DrawEntry, now: number): void {
    const budget = this.budgets.get(id) ?? this.create(id, definition, now);

    // A limit change resets the high-water mark, because thresholds are fractions of the limit
    // and would otherwise silently suppress legitimately breached warnings.
    if (budget.limit !== definition.limit) {
      budget.limit = definition.limit;
      budget.hwm = 0;
    }

    // A warnings-only change must not reset the mark.
    budget.warnings = definition.warnings;

    // A renewal change recomputes the next boundary from *now*, never refunding usage.
    if (renewalKey(budget.renewal) !== renewalKey(definition.renewal)) {
      budget.renewal = definition.renewal;
      budget.renewsAt = nextBoundary(definition.renewal, now, budget.createdAt);
      if (budget.renewsAt !== null) {
        this.renewals.push(budget.renewsAt, id);
      }
    }
    this.budgets.set(id, budget);
  }

  /** A draw against a budget that does not yet exist creates it from its definition. */
  private create(id: string, definition: Definition, now: number): BudgetState {
    const renewsAt = nextBoundary(definition.renewal, now, now);
    const budget = {
      limit: definition.limit,
      warnings: definition.warnings,
      renewal: definition.renewal,
      used: 0,
      renewsAt,
      hwm: 0,
      createdAt: now,
    } satisfies BudgetState;

    this.budgets.set(id, budget);
    this.order = null;
    if (renewsAt !== null) {
      this.renewals.push(renewsAt, id);
    }
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

  /**
   * Marks a reservation terminal, storing the body a repeat settle replays.
   *
   * The body is rendered once, here, and never again. A repeat settle reproduces the response
   * as it was first produced, group membership included, rather than re-rendering against a
   * group that has since moved on, which would report this reservation's `warningsCrossed`
   * beside `used` values some later request produced.
   */
  private settleWith(
    id: string,
    reservation: ReservationState,
    status: "committed" | "released",
    outcomes: Map<string, Outcome>,
    now: number,
  ): Reply {
    reservation.status = status;
    reservation.response = { budgets: this.groupView(outcomes) };
    reservation.settledAt = now;
    this.reservations.set(id, reservation);
    this.settled.push(now + SETTLED_RETENTION_MS, id);
    return { status: 200, body: reservation.response };
  }

  /**
   * `402`: the same array shape and ordering as a `200`, with pre-draw `used`/`remaining`
   * because nothing was applied.
   */
  private exceededReply(outcomes: Map<string, Outcome>, now: number): Reply {
    const views = this.groupView(outcomes);

    // `retry-after` is the seconds until the earliest renewal among exceeded budgets, omitted
    // when every one of them is `never`, since no amount of waiting would help. Read off the
    // stored instants rather than the rendered strings, which would mean formatting a date
    // only to parse it back.
    let soonest: number | null = null;
    for (const { id, exceeded } of views) {
      const renewsAt = exceeded ? this.budgets.get(id)!.renewsAt : null;
      if (renewsAt !== null && (soonest === null || renewsAt < soonest)) {
        soonest = renewsAt;
      }
    }

    // Counted over the budgets the request named, not the whole group: a budget that never
    // participated did not fail, and must not inflate the denominator.
    const failed = views.filter((v) => v.exceeded).length;
    const message = `${failed} of ${outcomes.size} budgets lacked capacity`;

    return ApiError.error(402, Code.BudgetExceeded, message).reply(
      { budgets: views },
      soonest === null
        ? undefined
        : { [Header.RetryAfter]: String(Math.max(0, Math.ceil((soonest - now) / 1000))) },
    );
  }
}

/** Accumulates one request's writes and deletes across every store sharing it. */
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

  keys(): IterableIterator<string> {
    return this.records.keys();
  }

  [Symbol.iterator](): IterableIterator<[string, T]> {
    return this.records[Symbol.iterator]();
  }
}

/**
 * Idempotency records, which live in storage rather than memory.
 *
 * A day of these on a busy group dwarfs the budgets themselves, and every one of them is dead
 * weight: they are looked up only by the exact key of the request replaying them, never
 * enumerated, and never interesting again after that. Loading them would put cold-start
 * latency and steady-state memory on a curve set by traffic instead of by how many budgets
 * the group has.
 *
 * Reads are synchronous because a request can touch exactly one key, and `prime` fetches it
 * before the handler runs.
 *
 * Reclamation cannot use an in-memory heap, because the records needing it are precisely the
 * ones this lifetime never wrote. Instead each record has a companion index entry keyed by its
 * deadline, and because those sort in deadline order, a bounded range scan returns exactly
 * what has come due and nothing else.
 */
class LazyStore<T extends { recordedAt: number }> {
  private cache = new Map<string, T>();
  private scannedAt = 0;

  constructor(
    private readonly prefix: string,
    private readonly index: string,
    private readonly batch: WriteBatch,
    private readonly storage: DurableObjectStorage,
  ) {}

  /** Reads one record into the cache, so the request that needs it can then read it freely. */
  async prime(name: string): Promise<void> {
    if (this.cache.has(name)) {
      return;
    }
    const stored = await this.storage.get<T>(this.prefix + name);
    if (stored !== undefined) {
      this.cache.set(name, stored);
    }
  }

  get(name: string): T | undefined {
    return this.cache.get(name);
  }

  set(name: string, value: T): void {
    this.cache.set(name, value);
    this.batch.put(this.prefix + name, value);
    this.batch.put(this.indexKey(value.recordedAt + IDEMPOTENCY_RETENTION_MS, name), 1);
  }

  /**
   * Drops records past their retention, in bounded batches.
   *
   * Rate limited because it costs a storage read: reclamation is housekeeping, and a group
   * taking a thousand requests a second does not need a thousand scans to find the handful of
   * records that came due in that second.
   */
  async reclaim(now: number): Promise<void> {
    if (now - this.scannedAt < SCAN_INTERVAL_MS) {
      return;
    }
    this.scannedAt = now;

    const due = await this.storage.list({
      start: this.index,
      end: this.indexKey(now, ""),
      limit: SCAN_BATCH,
    });
    for (const key of due.keys()) {
      const name = key.slice(key.indexOf(":", this.index.length) + 1);
      this.cache.delete(name);
      this.batch.drop(this.prefix + name);
      this.batch.drop(key);
    }
  }

  /** Zero-padded so the index sorts by deadline rather than by digit count. */
  private indexKey(deadline: number, name: string): string {
    return `${this.index}${String(deadline).padStart(16, "0")}:${name}`;
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
function drawnView(id: string, budget: BudgetState, outcome: Outcome): DrawnBudgetView {
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

/**
 * Lexicographic string order.
 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function reservationNotFound(): ApiError {
  return ApiError.error(404, Code.ReservationNotFound, "unknown or expired reservation");
}

function settled(message: string): ApiError {
  return ApiError.error(409, Code.ReservationSettled, message);
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let hex = "";
  for (const byte of buffer) {
    hex += HEX[byte];
  }
  return hex;
}
