/**
 * The promises the client makes at the type level, asserted by `make typecheck` rather than
 * at runtime.
 *
 * Every `@ts-expect-error` below is a *passing* assertion: if any of these lines ever starts
 * compiling, the comment itself becomes the error and the typecheck fails. Nothing here is
 * executed, which is why the calls are never awaited.
 */

import { HorseHolderClient, renewal } from "@horse-holder/client";

const hhldr = new HorseHolderClient({ baseUrl: "https://example.invalid", apiKey: "unused" });

const r2 = hhldr.group({
  id: "type-assertions-r2",
  budgets: {
    "put-ops": { limit: 1_000, renewal: renewal.monthly() },
    "storage-bytes": { limit: 1_000_000, renewal: renewal.monthly() },
  },
});

const emails = hhldr.group({
  id: "type-assertions-emails",
  budgets: { sent: { limit: 100, renewal: renewal.never() } },
});

export function typeAssertions(): void {
  // A budget id that is not declared in the group cannot be drawn.
  // @ts-expect-error "put-obs" is a typo, not a budget
  void r2.charge({ "put-obs": 1 }, { idempotencyKey: "k" });

  // Another group's budget id is just as unknown, so a group cannot be crossed by accident.
  // @ts-expect-error "sent" belongs to the emails group
  void r2.charge({ sent: 1 }, { idempotencyKey: "k" });

  // The idempotency key is required on every draw.
  // @ts-expect-error idempotencyKey is not optional
  void r2.charge({ "put-ops": 1 }, {});

  // A correction may only name budgets the reservation actually held.
  // @ts-expect-error "sent" was never reserved here
  void r2.commit("rsv_1", { sent: 1 });

  // A lease remembers what it held, so correcting a budget it did not reserve is a compile
  // error rather than a rejected request.
  void (async () => {
    const lease = await r2.reserve({ "put-ops": 1 }, { idempotencyKey: "k", ttlSeconds: 60 });
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
    const result = await r2.charge({ "put-ops": 1 }, { idempotencyKey: "k" });
    if (result.ok) {
      const untouched: number = result.get("storage-bytes").used;
      void untouched;
    }
    // @ts-expect-error "sent" is not in this group
    void result.get("sent");
  })();

  // A read takes no budget id at all: it returns the whole group in one request.
  void r2.read();

  // A group with a budget whose limit is not a number is not a group.
  // @ts-expect-error limit must be a number
  void hhldr.group({ id: "bad", budgets: { a: { limit: "lots", renewal: renewal.never() } } });

  // These two are legal, and are here to prove the assertions above fail for the right reason.
  void r2.charge({ "put-ops": 1, "storage-bytes": 2 }, { idempotencyKey: "k" });
  void emails.charge({ sent: 1 }, { idempotencyKey: "k" });
}
