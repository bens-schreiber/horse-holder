/**
 * A TypeScript client for Horse Holder: budget limits you check *before* you spend, not after.
 *
 * The idea is simple. You tell the server "this budget allows 1000 writes a day", and every
 * time you are about to do a write you ask for one. If there is room you get it and the counter
 * moves. If there is not, you get told no, and you skip the work instead of discovering at the
 * end of the month that you spent too much.
 *
 * ```ts
 * import { HorseHolderClient, renewal } from "@horse-holder/client";
 *
 * const hhldr = new HorseHolderClient({
 *   baseUrl: process.env.HORSEHOLDER_URL!,
 *   apiKey: process.env.HORSEHOLDER_API_KEY,
 * });
 *
 * const r2 = hhldr.group({
 *   id: "r2",
 *   budgets: {
 *     "put-ops": { limit: 1_000, renewal: renewal.daily({ timezone: "America/Chicago" }) },
 *   },
 * });
 *
 * const result = await r2.charge({ "put-ops": 1 }, { idempotencyKey: `upload-${id}` });
 * if (result.ok) {
 *   await uploadTheFile();
 * }
 * ```
 *
 * There are no dependencies here, and nothing in this package knows anything about a particular
 * server. Point `baseUrl` at any Horse Holder implementation and it works the same way.
 */

import { BudgetGroup, type WarningHandler, assertIdentifier, assertTenant } from "./group.ts";
import { invalid } from "./errors.ts";
import {
  type FetchLike,
  type HeaderSource,
  type RetryOptions,
  Transport,
  type TransportOptions,
} from "./transport.ts";
import type { BudgetsSpec, GroupSpec } from "./types.ts";

export { HorseHolderError, isHorseHolderError, type ErrorCode } from "./errors.ts";
export { BudgetGroup, type WarningHandler } from "./group.ts";
export {
  type CalendarOptions,
  type CalendarRenewal,
  type CalendarUnit,
  type IntervalRenewal,
  type NeverRenewal,
  renewal,
  type Renewal,
} from "./renewal.ts";
export { type FetchLike, type RetryOptions } from "./transport.ts";
export type {
  Amounts,
  BudgetOutcome,
  BudgetSpec,
  BudgetState,
  BudgetsSpec,
  DrawFailed,
  DrawOk,
  DrawOptions,
  DrawResult,
  GroupSpec,
  GroupState,
  Lease,
  RequestOptions,
  ReserveOptions,
  ReserveResult,
  SettleOptions,
  WarningCrossing,
} from "./types.ts";

/** How to reach the server. */
export interface ClientOptions extends TransportOptions {
  /**
   * Where the server lives. Give it the root, not the versioned path:
   * `https://budgets.example.com`, and `/v1` gets appended for you.
   */
  readonly baseUrl: string;
  /** Shorthand for sending `authorization: Bearer <key>`, which is what most servers want. */
  readonly apiKey?: string | undefined;
  /**
   * Headers to send on every request, either fixed or computed fresh each time.
   *
   * The protocol fixes where a credential goes (the `authorization` header) but not what it
   * looks like, so this is the escape hatch for whatever your server actually wants: a signed
   * value, a token that expires, something bespoke.
   *
   * ```ts
   * headers: async () => ({ authorization: `Bearer ${await mintToken()}` }),
   * ```
   */
  readonly headers?: HeaderSource | undefined;
  /**
   * A default tenant for every request.
   *
   * Leave it out for no tenant. Pass `""` for the tenant literally named `""`, which is a
   * different budget. Override per group or per call.
   */
  readonly tenant?: string | null | undefined;
  /** Your own `fetch`, for tests or a custom agent. Defaults to the global one. */
  readonly fetch?: FetchLike | undefined;
  /** How long to wait before giving up on a request. Defaults to 10 seconds. */
  readonly timeoutMs?: number | undefined;
  /**
   * Retry policy, or `false` to never retry.
   *
   * Dropped connections, timeouts, `429`, and `5xx` get retried with an exponential backoff and
   * some jitter, honoring `retry-after` when the server sends one. Being out of budget is never
   * retried, and neither is any other ordinary client error, since trying again would just get
   * the same answer.
   *
   * This is safe because of idempotency keys: a retried draw that already landed returns the
   * original result instead of spending twice.
   */
  readonly retry?: RetryOptions | false | undefined;
  /**
   * Called when a draw pushes a budget past one of its warning thresholds.
   *
   * Somewhere to hang logging or paging without checking `warningsCrossed` at every call site.
   * Each threshold fires once per period, so this stays quiet: crossing 80% once does not fire
   * again on the next draw, and dropping back under 80% and climbing again does not re-fire it
   * either. It resets when the budget resets.
   *
   * Fires once per budget that crossed something, so a draw touching three budgets that all
   * cross a threshold calls this three times.
   *
   * ```ts
   * onWarning: ({ id, thresholds, budget }) => {
   *   console.warn(`${id} passed ${thresholds.join(", ")}: ${budget.used}/${budget.limit}`);
   * },
   * ```
   */
  readonly onWarning?: WarningHandler | undefined;
}

/**
 * A connection to one Horse Holder server.
 *
 * The client holds the boring parts, the URL and credentials and timeouts, and hands out
 * groups. All the interesting methods live on the group.
 *
 * ```ts
 * const hhldr = new HorseHolderClient({
 *   baseUrl: process.env.HORSEHOLDER_URL!,
 *   apiKey: process.env.HORSEHOLDER_API_KEY,
 * });
 * ```
 *
 * Getting an account and an API key is not part of the protocol and so is not part of this
 * client. However your server hands those out, do that first and pass the key in here.
 */
export class HorseHolderClient {
  private readonly transport: Transport;
  private readonly tenant: string | null;
  private readonly onWarning: WarningHandler | undefined;

  constructor(options: ClientOptions) {
    this.transport = new Transport(options);
    this.tenant = options.tenant ?? null;
    assertTenant(this.tenant);
    this.onWarning = options.onWarning;
  }

  /**
   * Declare a group of budgets.
   *
   * This does not talk to the server. Budget configuration travels with each draw, so a group
   * is really just the one place in your code where those numbers live. Declaring it once and
   * using it everywhere is what stops two call sites from disagreeing about what the limit is.
   *
   * ```ts
   * const r2 = hhldr.group({
   *   id: "r2",
   *   budgets: {
   *     "put-ops": {
   *       limit: 1_000,
   *       warnings: [0.5, 0.8],
   *       renewal: renewal.daily({ timezone: "America/Chicago" }),
   *     },
   *     "storage-bytes": { limit: 1_000_000, renewal: renewal.monthly() },
   *   },
   * });
   * ```
   *
   * The budget names become part of the type, so a typo is caught while you are writing it
   * rather than silently creating a brand new budget called `put-obs` at runtime.
   *
   * Since this is an ordinary function call, per-customer limits are ordinary code:
   *
   * ```ts
   * const r2 = hhldr.group({
   *   id: "r2",
   *   budgets: { "put-ops": { limit: plan.putOps, renewal: renewal.monthly() } },
   * });
   * ```
   */
  group<const B extends BudgetsSpec>(spec: GroupSpec<B>): BudgetGroup<B> {
    assertIdentifier(spec.id, "group id");

    const budgets = Object.entries(spec.budgets);
    if (budgets.length === 0) {
      invalid(`group ${JSON.stringify(spec.id)} declares no budgets`);
    }
    for (const [id, budget] of budgets) {
      assertIdentifier(id, "budget id");
      if (!Number.isFinite(budget.limit) || budget.limit <= 0) {
        invalid(`budget ${JSON.stringify(id)}: limit must be positive, got ${budget.limit}`);
      }
      for (const warning of budget.warnings ?? []) {
        if (!(warning > 0 && warning < 1)) {
          const bounds = "warning thresholds must be strictly between 0 and 1";
          invalid(`budget ${JSON.stringify(id)}: ${bounds}, got ${warning}`);
        }
      }
    }

    return new BudgetGroup(spec, this.transport, this.tenant, this.onWarning);
  }
}
