# @horse-holder/client

Zero-dependency TypeScript client for [Horse Holder v1](https://github.com/bens-schreiber/horse-holder/blob/main/spec/spec.md). Ask before you spend.

It speaks the five endpoints and knows nothing about accounts, keys, or storage. Point `baseUrl` at any conforming server and keep your code.

```bash
npm install @horse-holder/client
```

## Declare your budgets

Budgets live in a group, and the group is what a draw is atomic across. Everything in one either goes through together or not at all, and no single draw can reach across two of them.

So you declare a group once, then spend against it.

```ts
import { HorseHolderClient, renewal } from "@horse-holder/client";

const hh = new HorseHolderClient({
  baseUrl: process.env.HORSEHOLDER_URL!,
  apiKey: process.env.HORSEHOLDER_API_KEY,
});

const r2 = hh.group({
  id: "r2",
  budgets: {
    "put-ops": { limit: 1_000, warnings: [0.5, 0.8], renewal: renewal.daily() },
    "storage-bytes": { limit: 1_000_000, renewal: renewal.monthly() },
  },
});
```

`group()` does no I/O. Limits ride along with every draw, so this is just the one place they live, which is what stops two call sites from disagreeing. It captures the budget ids as literal types, so everything below is checked against them.

It is also pure, so per-plan limits are ordinary code. Build a group from a customer record at request time.

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

result.get("put-ops").remaining; // never undefined

for (const { id, thresholds } of result.warningsCrossed) {
  console.warn(`${id} crossed ${thresholds.join(", ")}`);
}
```

Running out is a value, not an exception. Being told no is the client working correctly and the reason you called.

Every response covers the whole group, not just the budgets you drew from, so `get()` always has an answer.

## Cost known later

```ts
const lease = await r2.reserve(
  { "storage-bytes": estimate },
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

Crash before either one and the hold expires by itself. Your capacity comes home.

Leave a budget out of a correction and it commits at what it reserved. Omission means the estimate was right, never "release this one."

The lease remembers what it held, in the type:

```ts
await lease.commit({ "put-ops": 2 }); // compile error, that was never reserved
```

Settling somewhere else entirely? `r2.commit(reservationId, corrections?)` and `r2.release(reservationId)` do the same job without the lease.

## Reading

```ts
const state = await r2.read(); // whole group, one request

for (const budget of state.budgets) {
  console.log(`${budget.id}: ${budget.used}/${budget.limit}`);
}
```

Every number describes the same moment. Budgets you declared but never drew from do not exist on the server yet, so `get()` here can return `undefined`.

## Tenants

`r2.tenant("acme")` points the same group at somebody else. Same declaration, same connection, separate money. A per-call `tenant` beats it.

Absent and empty are different tenants, and HTTP libraries love to quietly collapse the two, so the type keeps them apart:

| You write      | Sends                     | Which means                   |
| -------------- | ------------------------- | ----------------------------- |
| nothing        | no `hh-tenant` header     | inherit the client or group   |
| `tenant: null` | no `hh-tenant` header     | the scope's default tenant    |
| `tenant: ""`   | `hh-tenant:` with nothing | an ordinary tenant named `""` |

## Errors and retries

Everything except running out throws one `HorseHolderError` with `status`, `code`, `message`, and `body`. `status` is null for network failures and timeouts.

```ts
import { isHorseHolderError } from "@horse-holder/client";

try {
  await lease.commit();
} catch (error) {
  if (isHorseHolderError(error) && error.code === "reservation_not_found") {
    // hold expired, treat it as unbudgeted and start over
  }
  throw error;
}
```

One class with a `code` string, not a subclass tree, because any server may define codes this client has never heard of.

Network blips, `408`, `429`, `5xx`, and `409 idempotency_in_progress` retry with backoff and jitter, honoring `retry-after`. A `402` never does, because that is an answer, not a failure.

Your idempotency keys are what make retries safe. Generate one per operation, not per attempt.

## Options

```ts
new HorseHolderClient({
  baseUrl, // required, "/v1" is appended for you
  apiKey, // sugar for `authorization: Bearer <key>`
  headers, // record or sync/async function, for any other auth scheme
  tenant, // default tenant
  fetch, // injected, defaults to globalThis.fetch
  timeoutMs, // default 10_000, overridable per call
  retry, // { attempts: 2, baseDelayMs: 100 } | false
  onWarning, // fires per crossed threshold on any successful draw
});
```

Every method also takes `tenant`, `signal`, `headers`, and `timeoutMs`.

More in [examples/ts](https://github.com/bens-schreiber/horse-holder/tree/main/examples/ts): seven runnable files, seven different services, each one asserts its own outcome.

## License

[MIT](https://github.com/bens-schreiber/horse-holder/blob/main/LICENSE). Go hold whatever horses you like.
