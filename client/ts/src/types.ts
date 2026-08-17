/**
 * What you declare, what you get back, and the shapes that cross the wire between them.
 *
 * Everything here is parameterized by `Ids`, the union of budget names a group has declared.
 * A group builds that union up one `.budget()` call at a time, and every draw, result, and
 * correction below is checked against it.
 *
 * The response types are the wire types: there is no second representation to map onto, only
 * `renewsAt` promoted from a string to a `Date`.
 */

import type { Renewal } from "./renewal.ts";

/** How many budgets one charge or reserve may touch at once. */
export const MAX_BUDGETS_PER_DRAW = 16;

/**
 * The characters allowed in a budget id, a group, or a tenant.
 *
 * Servers build their internal storage keys by gluing these names together, so letting
 * arbitrary text through would let one caller craft a name that collides with another's.
 * Sticking to letters, digits, underscore, dot, and dash keeps that impossible. Checked here
 * so you find out immediately rather than after a round trip.
 */
export const ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

// -- Declaring a group

/**
 * One budget's configuration: how much, how often it resets, when to warn.
 *
 * You send this with every draw, which means your code is the source of truth. Raising a limit
 * is editing this number and deploying. There is no separate admin call, no migration, and no
 * create-then-use dance. The server takes the new value on the next draw and keeps the usage
 * it already had, so changing a limit can never hand anybody free capacity.
 */
export interface BudgetSpec {
  /**
   * The allowance. Must be greater than zero.
   *
   * Lowering this below what is already spent is allowed and simply means the budget is
   * exhausted until it resets. Nobody gets a refund.
   */
  readonly limit: number;
  /**
   * Fractions of the limit at which to raise a warning, like `[0.5, 0.9]` for half and ninety
   * percent. Each must be greater than 0 and less than 1.
   *
   * `1.0` is not allowed, since that is not a warning, that is just being out of budget.
   */
  readonly warnings?: readonly number[] | undefined;
  /** When usage resets. Build it with the `renewal` helpers. */
  readonly renewal: Renewal;
}

/** The budgets a group has declared, keyed by id. */
export type BudgetsSpec<Ids extends string = string> = { readonly [K in Ids]: BudgetSpec };

/**
 * How much to draw from, or correct on, each of a set of budgets.
 *
 * Naming a budget outside the set is a compile error, and naming the same one twice is not
 * something you can write.
 */
export type Amounts<Ids extends string> = { readonly [K in Ids]?: number };

// -- Results

/**
 * What happened to one budget in a draw.
 *
 * You get one of these for every budget you named, whether the draw succeeded or not. When it
 * failed, `used` and `remaining` describe the budget as it stands *without* your draw, since
 * nothing was applied, and `warningsCrossed` is empty because no threshold can be crossed by
 * something that did not happen.
 */
export interface BudgetOutcome {
  /** The budget id you declared. */
  readonly id: string;
  /** How much this draw asked for. Always `0` on a release, which spends nothing. */
  readonly requested: number;
  /** Whether this particular budget is the one that ran out. */
  readonly exceeded: boolean;
  readonly limit: number;
  /** How much is spent so far this period, including anything held by open reservations. */
  readonly used: number;
  /** How much is left: `limit - used`, floored at zero. */
  readonly remaining: number;
  /** When usage resets, or `null` if this budget never resets. */
  readonly renewsAt: Date | null;
  /** Any warning thresholds this draw crossed, smallest first. Usually empty. */
  readonly warningsCrossed: readonly number[];
}

/** A budget's state, from a read. Nothing was drawn, so there is no outcome to report. */
export interface BudgetState {
  readonly id: string;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly renewsAt: Date | null;
}

/** A budget id paired with the thresholds a draw just crossed on it. */
export interface WarningCrossing<Id extends string = string> {
  readonly id: Id;
  readonly thresholds: readonly number[];
}

/**
 * Called when a draw pushes a budget past one of its warning thresholds.
 *
 * Set once on the client, so logging or paging has somewhere to live that is not every call
 * site.
 */
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

interface DrawResultBase<Ids extends string> {
  /**
   * Every budget in the group that exists on the server, not only the ones you drew from,
   * ordered by id. The ones you did not draw from report `requested: 0`.
   *
   * A budget you have declared but never drawn from does not exist yet and so is not in here.
   * `get()` covers that case and this list does not, which is why it is the one to reach for
   * when you want a particular budget rather than a tour of them all.
   */
  readonly budgets: readonly BudgetOutcome[];
  /**
   * The state of any budget in the group, drawn from or not.
   *
   * Always returns something, so there is nothing to null-check:
   *
   * ```ts
   * const result = await r2.draw("put-ops", 1).idempotent(key).charge();
   * result.get("put-ops").remaining;      // the one you drew
   * result.get("storage-bytes").used;     // also fine, you get the whole group back
   * result.get("nonsense");               // compile error, not in this group
   * ```
   */
  get(id: Ids): BudgetOutcome;
  /** The raw response body, in case your server includes fields this client does not model. */
  readonly raw: unknown;
}

/** A draw that went through. Every budget had room, and the counters moved. */
export interface DrawOk<Ids extends string> extends DrawResultBase<Ids> {
  /**
   * Always `true` here. Check this to tell the two results apart.
   *
   * `ok` answers exactly one question: did every budget have room? It is not a general "did the
   * call work" flag. Anything else that could go wrong has already thrown by the time you hold
   * one of these.
   */
  readonly ok: true;
  /**
   * Thresholds crossed by this draw, across all the budgets it touched. Usually empty.
   *
   * ```ts
   * for (const { id, thresholds } of result.warningsCrossed) {
   *   console.warn(`${id} just passed ${thresholds.join(", ")}`);
   * }
   * ```
   */
  readonly warningsCrossed: readonly WarningCrossing<Ids>[];
}

/**
 * A draw that was refused. At least one budget was out of room, so **nothing was applied to
 * any of them**, including the ones that had plenty left.
 *
 * `ok: false` means that and only that. A server error, bad credentials, a malformed request, a
 * dropped connection, or a timeout all throw instead, so they never reach this branch. If you
 * are holding one of these, the server was reachable, it understood you, and it said there is
 * not enough left. That is a value rather than an exception because running out is not a
 * malfunction, it is the answer you asked for.
 *
 * ```ts
 * if (!result.ok) {
 *   console.warn(`out of budget: ${result.exceeded.map((b) => b.id).join(", ")}`);
 *   if (result.retryAfter !== null) {
 *     console.warn(`try again in ${result.retryAfter}s`);
 *   }
 *   return;
 * }
 * ```
 */
export interface DrawFailed<Ids extends string> extends DrawResultBase<Ids> {
  readonly ok: false;
  /** Just the budgets that ran out. Never empty. */
  readonly exceeded: readonly BudgetOutcome[];
  /**
   * Roughly how many seconds until the soonest reset that would give you room again, or `null`
   * when waiting will not help because the budgets that ran out never reset.
   */
  readonly retryAfter: number | null;
}

/**
 * What a charge, a commit, or a release gives you back.
 *
 * Branch on `ok`. It is `false` only when a budget was exceeded; everything else throws.
 */
export type DrawResult<Ids extends string> = DrawOk<Ids> | DrawFailed<Ids>;

/**
 * A hold on some capacity, and the two ways to finish with it.
 *
 * `Held` is the set of budget ids the hold actually reserved, so correcting one it never held
 * is a compile error rather than a rejected request.
 */
export interface Reservation<Ids extends string, Held extends Ids = Ids> {
  /** The server's id for this hold. Carry it if you need to settle from another process. */
  readonly reservationId: string;
  /**
   * Spend the hold, optionally correcting the amounts now that you know the real cost.
   *
   * Anything you leave out is spent at the amount you reserved, which is what you want when the
   * estimate was right. It never means "give this one back":
   *
   * ```ts
   * await lease.commit({ "storage-bytes": actualBytes });  // corrects one, keeps the rest
   * await lease.commit();                                  // the estimate was right
   * ```
   *
   * Correcting *upward* is allowed, but the extra has to be available, so this can still come
   * back `ok: false`. If it does, the hold stays open and unchanged and you can either try a
   * smaller number or release it.
   */
  commit(corrections?: Amounts<Held>, options?: RequestOptions): Promise<DrawResult<Ids>>;
  /**
   * Give the hold back without spending it.
   *
   * Safe to call twice, so you can put it in a `catch` without tracking whether you already
   * released.
   */
  release(options?: RequestOptions): Promise<DrawOk<Ids>>;
}

/** A reservation you are holding right now, so you also know when it lapses. */
export interface Lease<Ids extends string, Held extends Ids = Ids> extends Reservation<Ids, Held> {
  /** When the hold lapses on its own and the capacity comes back automatically. */
  readonly expiresAt: Date;
}

/**
 * What a reserve gives you back.
 *
 * The successful branch is itself the lease, so one check both handles being refused and hands
 * you the thing you settle with:
 *
 * ```ts
 * const lease = await r2.draw("put-ops", 1).idempotent(key).reserve({ ttlSeconds: 60 });
 * if (!lease.ok) return;
 * await lease.commit();
 * ```
 */
export type ReserveResult<Ids extends string, Held extends Ids = Ids> =
  | (DrawOk<Ids> & Lease<Ids, Held>)
  | DrawFailed<Ids>;

/**
 * The state of a whole group, from a read.
 *
 * Only holds budgets that have actually been drawn from at least once.
 */
export interface GroupState<Ids extends string> {
  /** Every budget in the group that exists, ordered by id. */
  readonly budgets: readonly BudgetState[];
  /**
   * One budget's state, or `undefined` if nothing has ever been drawn from it.
   *
   * ```ts
   * const putOps = state.get("put-ops");
   * console.log(putOps === undefined ? "untouched" : `${putOps.used} used`);
   * ```
   */
  get(id: Ids): BudgetState | undefined;
  /** The raw response body. */
  readonly raw: unknown;
}

// -- Options

/** Options accepted by every call that reaches the server. */
export interface RequestOptions {
  /**
   * Which of your end users this request is for.
   *
   * Tenants let one budget declaration give every customer their own private copy of it, so
   * "1000 writes a day" means 1000 each rather than 1000 shared. Usually you set this with
   * `.tenant()` on the group or the draw rather than per call.
   *
   * There are three states, and they are genuinely three different budgets:
   *
   * - **leave it out** to use whatever the client, group, or draw was set up with
   * - **`null`** for no tenant at all, the plain unsubdivided budget
   * - **`""`** for a tenant whose name is the empty string, which is a normal tenant that
   *   happens to be called nothing
   *
   * That last distinction sounds pedantic, and it is, but HTTP libraries love to turn a missing
   * header into an empty string and thereby merge two customers' budgets. Keeping the three
   * states apart in the type is how this client refuses to do that to you.
   */
  readonly tenant?: string | null | undefined;
  /** Cancel the request. Composed with the client's timeout, so either one can fire. */
  readonly signal?: AbortSignal | undefined;
  /** Extra headers for this one call. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Overrides the client's timeout for this one call. */
  readonly timeoutMs?: number | undefined;
}

/** Options for a reserve, which can also say how long the hold should last. */
export interface ReserveOptions extends RequestOptions {
  /**
   * How long the hold lasts, in seconds. Defaults to whatever the server uses, often 300.
   *
   * Keep it comfortably shorter than the budget's reset period. A hold that is still open when
   * the budget resets carries over and counts against the new period too, which is correct but
   * surprising if you left a 24 hour hold on a daily budget.
   */
  readonly ttlSeconds?: number | undefined;
}

// -- Wire shapes

/** A `budgets` entry on a draw or settlement, exactly as the server sends it. */
export interface DrawnBudget {
  id: string;
  requested: number;
  exceeded: boolean;
  limit: number;
  used: number;
  remaining: number;
  renewsAt: string | null;
  warningsCrossed: number[];
}

/** Any response body this client understands. */
export interface Response$ {
  /**
   * A read reports state with no outcome attached, so the outcome fields are absent there.
   * Only `read` touches such a response, and it reads none of them.
   */
  budgets?: DrawnBudget[];
  reservationId?: string;
  expiresAt?: string;
  error?: { code?: string; message?: string };
}

/** One entry of a charge or reserve request body. */
export interface DrawEntry {
  id: string;
  amount: number;
  definition: BudgetSpec;
}
