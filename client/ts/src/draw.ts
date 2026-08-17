import { HorseHolderError, invalid } from "./errors.ts";
import { Header } from "./transport.ts";
import {
  type DrawRequest,
  Path,
  type Session,
  assertAmount,
  assertNonEmpty,
  draw,
  reservation,
  tenantFor,
  withTenant,
} from "./session.ts";
import {
  type DrawEntry,
  type DrawResult,
  MAX_BUDGETS_PER_DRAW,
  type RequestOptions,
  type ReserveOptions,
  type ReserveResult,
  type Response$,
} from "./types.ts";

/**
 * A draw with no idempotency key yet.
 *
 * There is nothing to send until you supply one, which is why `charge` and `reserve` are not
 * here: they appear on the {@link KeyedDraw} that `idempotent` hands back. A retry that could
 * spend twice is not a mistake this client lets you write.
 *
 * You do not construct one of these. `group.draw(...)` does.
 */
export class Draw<Ids extends string, Drawn extends Ids = never> {
  constructor(
    protected readonly session: Session,
    protected readonly entries: readonly DrawEntry[],
  ) {}

  /**
   * Add another budget to this draw.
   *
   * Everything named in one chain is spent together or not at all. Only ids declared on the
   * group compile, and naming the same one twice throws.
   */
  draw<K extends Ids>(id: K, amount: number): Draw<Ids, Drawn | K> {
    return new Draw(this.session, entriesWith(this.session, this.entries, id, amount));
  }

  /**
   * Point this draw at one of your end users, overriding whatever the group was bound to.
   *
   * ```ts
   * await ci.draw("build-minutes", 12).tenant("acme").idempotent(buildId).charge();
   * ```
   */
  tenant(id: string | null): Draw<Ids, Drawn> {
    return new Draw(withTenant(this.session, id), this.entries);
  }

  /**
   * Name the operation this draw is part of, so a retry cannot spend twice.
   *
   * If a request is sent twice with the same key, the second one returns whatever the first one
   * did instead of spending again. That is what makes it safe for this client to retry
   * automatically after a dropped connection.
   *
   * The important part: derive the key from the thing you are doing, not from the attempt. One
   * key per upload, per order, per webhook delivery, reused across every retry of that same
   * operation. A fresh random key on each attempt turns the protection off entirely.
   *
   * ```ts
   * .idempotent(`upload-${uploadId}`)   // good
   * .idempotent(crypto.randomUUID())    // pointless, unless you store and reuse it
   * ```
   */
  idempotent(key: string): KeyedDraw<Ids, Drawn> {
    assertNonEmpty(key, "idempotency key");
    return new KeyedDraw(this.session, this.entries, key);
  }
}

/**
 * A draw that knows what operation it belongs to, and so can be sent.
 *
 * The steps from {@link Draw} still work and still come back keyed, so the key can go anywhere
 * in the chain that reads well.
 */
export class KeyedDraw<Ids extends string, Drawn extends Ids = never> extends Draw<Ids, Drawn> {
  constructor(
    session: Session,
    entries: readonly DrawEntry[],
    private readonly key: string,
  ) {
    super(session, entries);
  }

  override draw<K extends Ids>(id: K, amount: number): KeyedDraw<Ids, Drawn | K> {
    const entries = entriesWith(this.session, this.entries, id, amount);
    return new KeyedDraw(this.session, entries, this.key);
  }

  override tenant(id: string | null): KeyedDraw<Ids, Drawn> {
    return new KeyedDraw(withTenant(this.session, id), this.entries, this.key);
  }

  /**
   * Spend it, right now.
   *
   * Use this when you know the cost before you do the work. If any budget is short, nothing is
   * spent from any of them and you get `ok: false` rather than an exception.
   *
   * ```ts
   * const result = await r2
   *   .draw("put-ops", 1)
   *   .draw("storage-bytes", 4096)
   *   .idempotent(`upload-${uploadId}`)
   *   .charge();
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
  charge(options?: RequestOptions): Promise<DrawResult<Ids>> {
    return draw<Ids>(this.session, this.request(Path.Charge, "charge", options));
  }

  /**
   * Hold the capacity now, settle up once you know what it actually cost.
   *
   * The held amount counts as spent immediately, so nothing else can take it while you work.
   * Then `commit` it, correcting the numbers if your estimate was off, or `release` it if the
   * operation never happened.
   *
   * ```ts
   * const lease = await r2
   *   .draw("storage-bytes", 10_000)
   *   .idempotent(`upload-${uploadId}`)
   *   .reserve({ ttlSeconds: 60 });
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
   * one it did not. If you forget to settle, the hold expires on its own and the capacity comes
   * back.
   */
  async reserve(options?: ReserveOptions): Promise<ReserveResult<Ids, Drawn>> {
    const request = this.request(Path.Reserve, "reserve", options);
    if (options?.ttlSeconds !== undefined) {
      request.headers[Header.TtlSeconds] = String(options.ttlSeconds);
    }

    const result = await draw<Ids>(this.session, request);
    if (!result.ok) {
      return result;
    }

    const { reservationId, expiresAt } = result.raw as Response$;
    if (reservationId === undefined || expiresAt === undefined) {
      throw new HorseHolderError({
        status: null,
        code: "invalid_response",
        message: "reserve succeeded without a reservationId and expiresAt",
        body: result.raw,
      });
    }

    // The hold belongs to whichever tenant the reserve went out as, so settling follows it
    // there rather than falling back to whatever the group was bound to.
    const held = withTenant(this.session, tenantFor(this.session, options));
    return {
      ...result,
      ...reservation<Ids, Drawn>(held, reservationId),
      expiresAt: new Date(expiresAt),
    };
  }

  private request(path: string, context: string, options: RequestOptions | undefined): DrawRequest {
    if (this.entries.length === 0) {
      invalid("a draw must name at least one budget");
    }
    return {
      path,
      headers: { [Header.IdempotencyKey]: this.key },
      body: { budgets: this.entries },
      options,
      context,
      refusable: true,
    };
  }
}

/** The first step of a chain. `BudgetGroup.draw` is the only caller. */
export function openDraw<Ids extends string, K extends Ids>(
  session: Session,
  id: K,
  amount: number,
): Draw<Ids, K> {
  return new Draw<Ids, K>(session, entriesWith(session, [], id, amount));
}

/** One more budget on a draw, checked against the group before it can go anywhere. */
function entriesWith(
  session: Session,
  entries: readonly DrawEntry[],
  id: string,
  amount: number,
): DrawEntry[] {
  const definition = session.budgets[id];
  if (definition === undefined) {
    // Types rule this out, but plain JavaScript callers land here instead of at the server.
    invalid(
      `budget ${JSON.stringify(id)} is not declared in group ${JSON.stringify(session.group)}`,
    );
  }
  if (entries.some((entry) => entry.id === id)) {
    invalid(`budget ${JSON.stringify(id)} is drawn twice in the same operation`);
  }
  assertAmount(id, amount);

  const next = [...entries, { id, amount, definition }];
  if (next.length > MAX_BUDGETS_PER_DRAW) {
    invalid(`a draw may name at most ${MAX_BUDGETS_PER_DRAW} budgets, got ${next.length}`);
  }
  return next;
}
