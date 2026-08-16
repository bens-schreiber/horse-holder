# @horse-holder/client

A zero-dependency TypeScript client for [Horse Holder v1](../../spec/spec.md): pre-flight budget
enforcement over HTTP.

It is written against the protocol rather than against any particular server. It speaks the five
endpoints and knows nothing about accounts, API key issuance, or storage, so pointing `baseUrl`
at any conforming implementation is the whole of the porting effort.

## Install

```
pnpm add @horse-holder/client
```

## The group is the unit

A **group** is the atomicity domain. It travels in a required header, it is part of every
budget's identity, and a draw cannot span groups because there is no way to express one. So a
group, not a budget, is this client's primary object: you declare a group once with its member
budgets, then draw against those members.

```ts
import { HorseHolderClient, renewal } from "@horse-holder/client";

const hhldr = new HorseHolderClient({
  baseUrl: process.env.HORSEHOLDER_URL!,
  apiKey: process.env.HORSEHOLDER_API_KEY,
  tenant: "my-tenant",
});

const r2 = hhldr.group({
  id: "r2",
  budgets: {
    "put-ops": {
      limit: 1_000,
      warnings: [0.1, 0.5, 0.8],
      renewal: renewal.daily({ timezone: "America/Chicago" }),
    },
    "storage-bytes": {
      limit: 1_000_000,
      warnings: [0.8],
      renewal: renewal.monthly({ timezone: "America/Chicago" }),
    },
  },
});
```

`group()` performs no I/O. Definitions travel inline with every draw, so this is simply the one
place they live, which is what stops two call sites from disagreeing about what the limit is. It
validates eagerly and captures the budget ids as literal types, so every call below is checked
against them.

Because it is pure, per-customer limits are ordinary code: build a group from a plan tier or a
customer record at request time.

## Cost known up front

```ts
const result = await r2.charge(
  { "put-ops": 1, "storage-bytes": 1_000 },
  { idempotencyKey: `upload-${uploadId}` },
);

if (!result.ok) {
  result.exceeded; // the budgets that ran out
  result.retryAfter; // seconds until the soonest reset, or null
  return;
}

result.get("put-ops").remaining; // always returns a value, never undefined

for (const { id, thresholds } of result.warningsCrossed) {
  console.warn(`${id} crossed ${thresholds.join(", ")}`);
}
```

Running out of budget is a **value, not an exception**. Being told no is the client working
correctly and the reason you called, so it comes back as `ok: false` with every budget's state
attached, including the ones that were fine.

Every response covers the **whole group**, not only the budgets you drew from, so `get()` always
has an answer for any budget in the group and never returns `undefined`.

## Cost known only afterward

```ts
const lease = await r2.reserve(
  { "put-ops": 1, "storage-bytes": 1_000 },
  { idempotencyKey: `upload-${uploadId}`, ttlSeconds: 60 },
);

if (!lease.ok) return;

try {
  const cost = await performOperation();
  await lease.commit({ "storage-bytes": cost.storageBytes });
} catch (error) {
  await lease.release();
  throw error;
}
```

The successful branch of `reserve` _is_ the lease, so one `ok` check both handles the refusal and
gives you the verbs to settle with. Any budget left out of a correction commits at its reserved
amount: omission means "the estimate was right," never "release this one."

The lease also remembers **which** budgets it held, in the type. Correcting one it never
reserved is a compile error, not a rejected request:

```ts
const lease = await r2.reserve({ "put-ops": 1 }, { idempotencyKey: key, ttlSeconds: 60 });
if (!lease.ok) return;

await lease.commit({ "put-ops": 2 }); // fine
await lease.commit({ "storage-bytes": 1 }); // compile error: not part of this reservation
```

When the settlement crosses a process boundary, use `r2.commit(reservationId, corrections?)` and
`r2.release(reservationId)` directly. The lease is sugar over exactly those.

## Reading

```ts
const state = await r2.read(); // the whole group, one request

for (const budget of state.budgets) {
  console.log(`${budget.id}: ${budget.used}/${budget.limit}`);
}

state.get("put-ops")?.used;
```

One request gets the entire group, and every number in it describes the same moment. Budgets you
have declared but never drawn from are not in `budgets`, since they do not exist on the server
until something spends from them, so `get()` on a read returns `BudgetState | undefined`.

## Tenants

`r2.tenant("acme")` returns the same group bound to another tenant, sharing one transport. A
per-call `tenant` overrides it.

The absent-versus-empty distinction lives in the type, because those are **different budgets**
and HTTP libraries love to collapse them silently:

| You write      | The client sends                 | Which addresses                     |
| -------------- | -------------------------------- | ----------------------------------- |
| nothing        | no `hh-tenant` header            | inherit the client or group default |
| `tenant: null` | no `hh-tenant` header            | the scope's default tenant          |
| `tenant: ""`   | `hh-tenant:` with an empty value | an ordinary tenant named `""`       |

## Errors

Everything except running out of budget throws a single `HorseHolderError` carrying `status`,
`code`, `message`, and `body`, with `status` null for network failures and timeouts. One class
with a `code` string rather than a subclass tree, because any implementation may define codes
this client has never heard of, and a closed union of subclasses would make those
unrepresentable.

```ts
import { isHorseHolderError, type ErrorCode } from "@horse-holder/client";

try {
  await lease.commit();
} catch (error) {
  if (isHorseHolderError(error) && error.code === "reservation_not_found") {
    // the hold expired; treat the operation as unbudgeted and start over
  }
  throw error;
}
```

`ErrorCode` is a union of the standard codes, for an exhaustive `switch` over the ones every
server is expected to use.

## Client options

```ts
new HorseHolderClient({
  baseUrl, // required, "/v1" is appended for you
  apiKey, // sugar for `authorization: Bearer <key>`
  headers, // static record or sync/async function, for any other auth scheme
  tenant, // default tenant
  fetch, // injected, defaults to globalThis.fetch
  timeoutMs, // default 10_000, overridable per call
  retry, // { attempts: 2, baseDelayMs: 100 } | false
  onWarning, // fires per crossed threshold on any successful draw
});
```

Every method also takes `tenant`, `signal`, `headers`, and `timeoutMs`.

**Retries.** Network errors, `408`, `429`, `5xx`, and `409 idempotency_in_progress` retry with
exponential backoff and jitter, honoring `retry-after`. Nothing else does: never a `402`, never
another `4xx`. This is safe precisely because the idempotency keys are yours and are reused
across attempts, so a replayed draw returns the original result rather than charging twice.
Generate one key per logical operation, not per attempt.

**Client-side validation** is limited to what the protocol mandates, so it holds against every
implementation: the identifier charset, 1 to 16 amounts per draw, `limit > 0`, `0 < warning < 1`,
and finite non-negative amounts. Group-spanning draws, duplicate ids, unknown budget ids, and
corrections outside their reservation are prevented by the types instead of being checked at
runtime.

## Examples and tests

The test surface is [examples/](../../examples): seven examples across seven different services,
each a standalone file importing only `node:assert` and this client. Every one prints what it
did and asserts the outcome. `make dev` in one terminal, `make example` in another.
