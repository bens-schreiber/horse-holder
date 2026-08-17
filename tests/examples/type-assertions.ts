/**
 * The promises the client makes at the type level, asserted by `make typecheck` rather than
 * at runtime.
 *
 * Every `@ts-expect-error` below is a *passing* assertion: if any of these lines ever starts
 * compiling, the comment itself becomes the error and the typecheck fails. Nothing here is
 * executed, which is why the calls are never awaited.
 */

import { DEFAULT_BASE_URL, HorseHolderClient, renewal } from "@horse-holder/client";

const hh = new HorseHolderClient({ baseUrl: "https://example.invalid", apiKey: "unused" });

const r2 = hh
  .group("type-assertions-r2")
  .budget("put-ops", { limit: 1_000, renewal: renewal.monthly() })
  .budget("storage-bytes", { limit: 1_000_000, renewal: renewal.monthly() });

const emails = hh.group("type-assertions-emails").budget("sent", {
  limit: 100,
  renewal: renewal.never(),
});

export function typeAssertions(): void {
  // A budget id that is not declared in the group cannot be drawn.
  // @ts-expect-error "put-obs" is a typo, not a budget
  void r2.draw("put-obs", 1);

  // Another group's budget id is just as unknown, so a group cannot be crossed by accident.
  // @ts-expect-error "sent" belongs to the emails group
  void r2.draw("sent", 1);

  // A group with nothing declared on it has nothing to draw, and says so.
  // @ts-expect-error an empty group has no budget ids at all
  void hh.group("type-assertions-empty").draw("anything", 1);

  // Nothing can be sent until the operation has a name, so an unkeyed draw has no `charge`.
  // @ts-expect-error charge appears only after .idempotent()
  void r2.draw("put-ops", 1).charge();

  // @ts-expect-error and neither does reserve
  void r2.draw("put-ops", 1).reserve({ ttlSeconds: 60 });

  // The key can come anywhere in the chain: the steps after it stay keyed.
  void r2.draw("put-ops", 1).idempotent("k").draw("storage-bytes", 2).tenant("acme").charge();

  // A correction may only name budgets the reservation actually held.
  // @ts-expect-error "sent" is not in this group at all
  void r2.reservation("rsv_1").commit({ sent: 1 });

  // A lease remembers what it held, so correcting a budget it did not reserve is a compile
  // error rather than a rejected request.
  void (async () => {
    const lease = await r2.draw("put-ops", 1).idempotent("k").reserve({ ttlSeconds: 60 });
    if (!lease.ok) {
      return;
    }

    // @ts-expect-error "storage-bytes" is in the group but was not part of this reservation
    void lease.commit({ "storage-bytes": 1 });

    // Correcting what it did reserve is fine, as is committing the estimate unchanged.
    void lease.commit({ "put-ops": 2 });
    void lease.commit();
  })();

  // get() is total over the group, so it needs no null check even for a budget this draw did
  // not touch. Asking for something outside the group is still a compile error.
  void (async () => {
    const result = await r2.draw("put-ops", 1).idempotent("k").charge();
    if (result.ok) {
      const untouched: number = result.get("storage-bytes").used;
      void untouched;
    }
    // @ts-expect-error "sent" is not in this group
    void result.get("sent");
  })();

  // A read takes no budget id at all: it returns the whole group in one request.
  void r2.read();

  // A budget whose limit is not a number is not a budget.
  // @ts-expect-error limit must be a number
  void hh.group("bad").budget("a", { limit: "lots", renewal: renewal.never() });

  // `baseUrl` defaults to the hosted server, so both the option and the whole options object
  // are optional. None of these construct a request, so no server is ever reached.
  void new HorseHolderClient();
  void new HorseHolderClient({ apiKey: "unused" });
  void new HorseHolderClient({ baseUrl: DEFAULT_BASE_URL });

  // These two are legal, and are here to prove the assertions above fail for the right reason.
  void r2.draw("put-ops", 1).draw("storage-bytes", 2).idempotent("k").charge();
  void emails.draw("sent", 1).idempotent("k").charge();
}
