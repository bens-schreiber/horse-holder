<div align="center">

<img src="https://media1.tenor.com/m/DUnHVP-oFKMAAAAd/all-the-deer-deer.gif" width="420" alt="A bouncer letting in deer, and more deer, and more deer" />

# Hold your horses.

[Website](https://horseholder.com) · [npm](https://www.npmjs.com/package/@horse-holder/client) · [Spec](spec/spec.md) · [OpenAPI](spec/openapi.yaml) · [Client](client/ts) · [MIT](LICENSE)
</div>

```bash
# Install via pnpm
pnpm add @horse-holder/client

# Install via npm
npm install @horse-holder/client
```

## Ask before you spend

```ts
import { HorseHolderClient, renewal } from "@horse-holder/client";

const hh = new HorseHolderClient({
  apiKey: process.env.HORSEHOLDER_API_KEY,
});

const storage = hh
  .group("r2-storage")
  .budget("put-ops", {
    limit: 1_000_000,
    renewal: renewal.monthly(),
  })
  .budget("egress-bytes", {
    limit: 50_000_000_000,
    renewal: renewal.monthly(),
  });

const result = await storage
  .draw("put-ops", 1)
  .draw("egress-bytes", object.size)
  .idempotent(uploadId)
  .charge();

if (!result.ok) {
  return tooExpensive({ retryAfter: result.retryAfter });
}

await bucket.put(key, object);
```

Both budgets go through, or neither does.

No setup call. No migration. Limits ride along with every draw, so changing one is changing a constant.

> [!NOTE]
> Modifying a budget's limit does not reset the current usage, but may trigger a warning or exceed if the new limit is lower than the current usage.

## Lifetime caps

Some budgets should never come back.

```ts
// 100 free renders, ever.
const trial = hh.group("trial").budget("renders", { limit: 100, renewal: renewal.never() });
```

`renewsAt` comes back `null`, and so does `retryAfter`, because waiting will not help anyone.

## Rate limits, stacked

Windows reset on the clock rather than rolling continuously:

```ts
const api = hh
  .group("api-calls")
  .budget("per-minute", { limit: 60, renewal: renewal.seconds(60) })
  .budget("per-hour", { limit: 1_000, renewal: renewal.seconds(3_600) })
  .budget("per-day", { limit: 10_000, renewal: renewal.daily({ timezone: "America/Chicago" }) });

// One call. Trips on whichever wall it hits first.
const burst = await api
  .draw("per-minute", 1)
  .draw("per-hour", 1)
  .draw("per-day", 1)
  .idempotent(requestId)
  .charge();

if (!burst.ok) {
  return rateLimited({
    retryAfter: burst.retryAfter,
    hit: burst.exceeded.map((b) => b.id), // ["per-minute"]
  });
}
```

## One budget per customer

`tenant()` re-points the same group at somebody else. Same declaration, same connection, separate money. It sits on the group when the customer is fixed, and on the draw when it changes per request.

```ts
const ci = hh
  .group("ci-builds")
  .budget("build-minutes", { limit: 500, renewal: renewal.monthly() });

const cmpgn1 = ci.tenant("vox machina");

await cmpgn1.draw("build-minutes", 12).idempotent("build-1187").charge();
await ci.draw("build-minutes", 3).tenant("mighty nein").idempotent("build-2043").charge();
// 500 each. They have never met.
```

Groups are immutable and never touch the network, so per-plan limits are just code:

```ts
const limits = { free: 100, pro: 5_000, enterprise: 1_000_000 };

const seats = hh
  .group("seats")
  .budget("api-calls", { limit: limits[customer.plan], renewal: renewal.monthly() });

const quota = seats.tenant(customer.id);
```

## Warning thresholds

Thresholds fire on the way up, once per period.

```ts
const mail = hh.group("email").budget("sends", {
  limit: 200_000,
  warnings: [0.5, 0.8, 0.95],
  renewal: renewal.monthly(),
});

const sent = await mail.draw("sends", batch.length).idempotent(batchId).charge();

if (sent.ok) {
  for (const { id, thresholds } of sent.warningsCrossed) {
    await page(`${id} crossed ${thresholds.join(", ")}`);
  }
}
```

Each threshold fires once per period. Usage bouncing around 80% pages you once, not forty times.

One big draw jumping 40% to 90% reports both `0.5` and `0.8`, so nothing gets skipped either.

## Reserve now, settle later

```ts
const lease = await storage
  .draw("egress-bytes", estimate)
  .idempotent(jobId)
  .reserve({ ttlSeconds: 60 });

if (!lease.ok) return;

try {
  const actual = await streamItAll();
  await lease.commit({ "egress-bytes": actual.bytes }); // over refunds, under gets checked
} catch (err) {
  await lease.release();
  throw err;
}
```

Crash before either one and the hold expires by itself. Your capacity comes home.

The lease knows what it held, in the type:

```ts
await lease.commit({ "put-ops": 1 }); // compile error, that was never reserved
```

## Errors and retries

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

Network blips, `429`, and `5xx` retry themselves with backoff. A `402` never does, because that is an answer, not a failure.

Your idempotency keys make the retries safe. Generate one per operation, not per attempt.

More in [examples/ts](examples/ts): seven runnable files, seven different services, each one asserts its own outcome.

## Self Horse-ing

Two ways to hold your own horses.

### 1. Run this implementation

[api/](api/) is standalone. Cloudflare Workers plus Durable Objects, one object per group, so two draws on the same budgets cannot race each other.

```bash
git clone https://github.com/bens-schreiber/horse-holder
cd horse-holder && pnpm install

make dev    # localhost:8787
make test   # conformance suite plus our own
make check  # types, format, lint, both suites
```

Ship it to your own account:

```bash
cd api
pnpm wrangler kv namespace create API_KEYS   # put the id in wrangler.jsonc
pnpm wrangler deploy
```

That deploys the API and nothing else. No file in `api/` imports from `site/`.

Then point any client at it:

```ts
const hh = new HorseHolderClient({ baseUrl: "https://your-worker.workers.dev" });
```

Free tier holds a lot of horses.

### 2. Write your own

A full description of how to conform to the Horse Holder protocol can be found in [spec/spec.md](spec/spec.md), and an OpenAPI schema found in [spec/openapi.yaml](spec/openapi.yaml).

| Endpoint           | Does                                             |
| ------------------ | ------------------------------------------------ |
| `POST /v1/charge`  | Spend now, atomically, across up to 16 budgets   |
| `POST /v1/reserve` | Hold capacity when the cost is not known yet     |
| `POST /v1/commit`  | Settle a hold, correcting the amount if you like |
| `POST /v1/release` | Give a hold back unspent                         |
| `GET /v1/budget`   | Read the whole group at one instant              |

The bar for conforming is [tests/spec/](tests/spec/), which is implementation-agnostic on purpose. Point it at your server. If it passes, you conform.

**Every Horse Holder client works with your implementation.** Swap `baseUrl`, keep your code. The client in [client/ts](client/ts) knows the five endpoints and knows nothing about accounts, keys, or storage, so porting it to your server is a one-line change.

## License

[MIT](LICENSE). Go hold whatever horses you like.
