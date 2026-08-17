import { BudgetGroup } from "./group.ts";
import { type Session, assertIdentifier, assertTenant } from "./session.ts";
import {
  type FetchLike,
  type HeaderSource,
  type RetryOptions,
  Transport,
  type TransportOptions,
} from "./transport.ts";
import type { WarningHandler } from "./types.ts";

export { HorseHolderError, isHorseHolderError, type ErrorCode } from "./errors.ts";
export { Draw, KeyedDraw } from "./draw.ts";
export { BudgetGroup } from "./group.ts";
export {
  type CalendarOptions,
  type CalendarRenewal,
  type CalendarUnit,
  type IntervalRenewal,
  type NeverRenewal,
  renewal,
  type Renewal,
} from "./renewal.ts";
export { DEFAULT_BASE_URL, type FetchLike, type RetryOptions } from "./transport.ts";
export type {
  Amounts,
  BudgetOutcome,
  BudgetSpec,
  BudgetState,
  BudgetsSpec,
  DrawFailed,
  DrawOk,
  DrawResult,
  GroupState,
  Lease,
  RequestOptions,
  Reservation,
  ReserveOptions,
  ReserveResult,
  WarningCrossing,
  WarningHandler,
} from "./types.ts";

/** How to reach the server. */
export interface ClientOptions extends TransportOptions {
  /**
   * Where the server lives. Give it the root, not the versioned path:
   * `https://budgets.example.com`, and `/v1` gets appended for you.
   *
   * Leave it out for the hosted server at `https://horseholder.com`. Point it anywhere else to
   * use your own deployment, or any other conforming implementation.
   */
  readonly baseUrl?: string | undefined;
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
   * different budget. Override per group, per draw, or per call.
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
 * const hh = new HorseHolderClient({
 *   apiKey: process.env.HORSEHOLDER_API_KEY,
 * });
 * ```
 *
 * `baseUrl` defaults to the hosted server at `https://horseholder.com`, so pointing somewhere
 * else is the only reason to set it:
 *
 * ```ts
 * const hh = new HorseHolderClient({ baseUrl: "https://your-worker.workers.dev" });
 * ```
 *
 * Getting an account and an API key is not part of the protocol and so is not part of this
 * client. However your server hands those out, do that first and pass the key in here.
 */
export class HorseHolderClient {
  private readonly transport: Transport;
  private readonly tenant: string | null;
  private readonly onWarning: WarningHandler | undefined;

  constructor(options: ClientOptions = {}) {
    this.transport = new Transport(options);
    this.tenant = options.tenant ?? null;
    assertTenant(this.tenant);
    this.onWarning = options.onWarning;
  }

  /**
   * Open a group, then declare its budgets on it.
   *
   * This does not talk to the server, and neither does anything else until a draw ends in a
   * charge or a reserve. Configuration travels with every draw, so there is no setup call and
   * no migration: a group is the one place in your code where the numbers live.
   *
   * ```ts
   * const r2 = hh.group("r2")
   *   .budget("put-ops", { limit: 1_000, renewal: renewal.daily() })
   *   .budget("storage-bytes", { limit: 1_000_000, renewal: renewal.monthly() });
   * ```
   *
   * A group with nothing declared on it yet is legal and useless: there is nothing a draw can
   * name until you have declared something.
   */
  group(id: string): BudgetGroup {
    assertIdentifier(id, "group id");
    const session: Session = {
      transport: this.transport,
      group: id,
      budgets: {},
      tenant: this.tenant,
      onWarning: this.onWarning,
    };
    return new BudgetGroup(session);
  }
}
