/**
 * A group of budgets, and everything you can do with them.
 */

import { invalid } from "./errors.ts";
import { toError } from "./transport.ts";
import {
  Path,
  type Session,
  assertIdentifier,
  budgetsOf,
  reservation,
  tenantFor,
  toDate,
  withTenant,
} from "./session.ts";
import { type Draw, openDraw } from "./draw.ts";
import type { BudgetSpec, BudgetsSpec, GroupState, RequestOptions, Reservation } from "./types.ts";

/**
 * A group of budgets, and everything you can do with them.
 *
 * A group is the unit here rather than an individual budget, because the server treats it that
 * way: budgets in one group can be spent together in a single all-or-nothing operation, and
 * budgets in different groups cannot be combined at all. So you declare the group and then draw
 * from its members.
 *
 * ```ts
 * const storage = hh.group("r2-storage")
 *   .budget("put-ops", { limit: 1_000_000, renewal: renewal.monthly() })
 *   .budget("egress-bytes", { limit: 50_000_000_000, renewal: renewal.monthly() });
 * ```
 *
 * Put budgets together when a single operation spends from both of them at once, like an upload
 * that costs one write and some bytes. Keep unrelated things apart, like your email quota and
 * your storage quota, since separate groups can be drawn at the same time without waiting on
 * each other.
 *
 * One thing to be careful about: the group name is part of each budget's identity. Renaming the
 * group does not move your budgets, it silently starts new ones at zero. Pick a name and keep
 * it.
 *
 * `Ids` is the union of budget names declared so far. Every draw, result, and correction below
 * is checked against it, so a typo is caught while you are writing it rather than silently
 * creating a brand new budget called `put-obs` at runtime.
 */
export class BudgetGroup<Ids extends string = never> {
  /** The group name. */
  readonly id: string;

  /** The budgets declared so far. */
  readonly budgets: BudgetsSpec<Ids>;

  constructor(private readonly session: Session) {
    this.id = session.group;
    this.budgets = session.budgets as BudgetsSpec<Ids>;
  }

  /**
   * Declare a budget in this group.
   *
   * This does no I/O. Configuration travels with each draw, so a group is really just the one
   * place in your code where those numbers live. Declaring them once and using them everywhere
   * is what stops two call sites from disagreeing about what the limit is.
   *
   * ```ts
   * const r2 = hh.group("r2")
   *   .budget("put-ops", {
   *     limit: 1_000,
   *     warnings: [0.5, 0.8],
   *     renewal: renewal.daily({ timezone: "America/Chicago" }),
   *   })
   *   .budget("storage-bytes", { limit: 1_000_000, renewal: renewal.monthly() });
   * ```
   *
   * The name becomes part of the group's type, and the group it returns is a new one, so
   * per-customer limits are ordinary code:
   *
   * ```ts
   * const r2 = hh.group("r2").budget("put-ops", { limit: plan.putOps, renewal: renewal.monthly() });
   * ```
   */
  budget<K extends string>(id: K, spec: BudgetSpec): BudgetGroup<Ids | K> {
    assertIdentifier(id, "budget id");
    if (this.session.budgets[id] !== undefined) {
      invalid(`budget ${JSON.stringify(id)} is declared twice in group ${JSON.stringify(this.id)}`);
    }
    if (!Number.isFinite(spec.limit) || spec.limit <= 0) {
      invalid(`budget ${JSON.stringify(id)}: limit must be positive, got ${spec.limit}`);
    }
    for (const warning of spec.warnings ?? []) {
      if (!(warning > 0 && warning < 1)) {
        const bounds = "warning thresholds must be strictly between 0 and 1";
        invalid(`budget ${JSON.stringify(id)}: ${bounds}, got ${warning}`);
      }
    }

    return new BudgetGroup<Ids | K>({
      ...this.session,
      budgets: { ...this.session.budgets, [id]: spec },
    });
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
   *
   * The group is immutable, so this is safe to do inline on a shared declaration. A single draw
   * can be pointed somewhere else too, with `.tenant()` on the draw.
   */
  tenant(id: string | null): BudgetGroup<Ids> {
    return new BudgetGroup<Ids>(withTenant(this.session, id));
  }

  /**
   * Start a draw against one of this group's budgets.
   *
   * Nothing happens until the chain ends in `charge()` or `reserve()`:
   *
   * ```ts
   * const result = await r2
   *   .draw("put-ops", 1)
   *   .draw("storage-bytes", 4096)
   *   .idempotent(`upload-${uploadId}`)
   *   .charge();
   * ```
   */
  draw<K extends Ids>(id: K, amount: number): Draw<Ids, K> {
    return openDraw<Ids, K>(this.session, id, amount);
  }

  /**
   * A hold you only carried the id of.
   *
   * `Lease` is nicer and is what you want when you still have the reserve's result in hand. Use
   * this one when the work finished somewhere else and all that came with it was the id.
   *
   * ```ts
   * await r2.reservation(reservationId).commit({ "storage-bytes": actualBytes });
   * ```
   *
   * Committing throws if the hold already expired or was already released, since both mean your
   * code lost track of something rather than that a budget ran out. Releasing something already
   * released is fine, so that one is safe to call from a `catch`.
   */
  reservation(reservationId: string): Reservation<Ids> {
    return reservation<Ids, Ids>(this.session, reservationId);
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
  async read(options?: RequestOptions): Promise<GroupState<Ids>> {
    const result = await this.session.transport.send({
      path: Path.Budget,
      method: "GET",
      group: this.id,
      tenant: tenantFor(this.session, options),
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
}
