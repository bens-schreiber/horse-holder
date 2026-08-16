# Horse Holder

A conforming [Horse Holder v1](spec/spec.md) server: pre-flight budget enforcement over HTTP,
on Cloudflare Workers and Durable Objects.

One Durable Object per `(scope, tenant, group)` triple. That triple is the protocol's atomicity
domain, so making it the transactional unit means all-or-nothing holds structurally rather than
by careful request handling: a draw cannot span two objects, and inside one there is no
concurrency for a check-and-decrement to lose to. The Worker validates every request and reaches
the storage tier only by typed RPC, so nothing downstream re-parses the wire format.

## Layout

```
api/src/index.ts       Worker entry for the standalone API: fetch handler plus the DO export
api/src/serve.ts       Routing, validation, and RPC dispatch
api/src/auth.ts        Bearer API keys, one scope each
api/src/budget.ts      BudgetGroup DO: all protocol semantics, reached by RPC
api/src/expiry.ts      The deadline heap that drives expiry, renewal, and reclamation
api/src/schema.ts      Headers, paths, codes, zod request schemas, error envelope
api/src/renewal.ts     Renewal rules and their boundary math (timezones, DST, clamping)
api/tests/             Our extensions and internals
tests/spec/            Protocol conformance suite, implementation-agnostic
tests/*.ts             Its scaffolding: server setup, harness, request vocabulary
client/ts/             TypeScript client for the protocol, vendor-neutral, zero deps
examples/ts/           Runnable client examples, one per file, nothing else
tests/examples/        The driver that runs them and asserts they pass
site/                  The website, and the Worker that serves it and the API
```

[api/](api/) is standalone: `wrangler deploy` from that directory publishes the whole API and
nothing else, and no file in it imports from `site/`. See [api/README.md](api/README.md) for
deploying it by itself.

The website is an optional front end over that same code rather than a second implementation.
Astro owns routing; `site/src/pages/v1/[...path].ts` delegates every API request to `serve()` in
`api/src/serve.ts`, unchanged. `site/worker.ts` is the entry `wrangler` deploys for the site: it
re-exports Astro's handler alongside the `BudgetGroup` Durable Object, which has to be exported
from the Worker's own entry point. So one Worker serves both the pages and `/v1/*`, and same
origin means no CORS, no allowlist, and no API URL for the site to configure.

`serve.ts` is split from `index.ts` so the handler carries no value import of the Durable Object
class. `budget.ts` imports `cloudflare:workers`, which resolves only inside workerd; a handler
that pulled it in could not be loaded by `astro dev`'s Vite SSR, which is what `/keys` needs.

The front page is prerendered and served from the assets binding at no compute cost. `/keys` is
the one page with behavior: a plain form that POSTs to itself and issues an account and its first
key. The site ships zero client JavaScript, which is why its CSP can be `script-src 'none'`.

`examples/ts` deliberately sits outside every workspace package, so that an example reads
exactly like calling code in someone else's project. That is why the root `package.json`
depends on `@horse-holder/client`: it is what resolves the import for those files.

## Commands

Everything runs from the `Makefile` at the repo root; there is no `scripts` block in any
`package.json`.

| Command             | Does                                                 |
| ------------------- | ---------------------------------------------------- |
| `make test`         | Both suites (the default target)                     |
| `make test-spec`    | Conformance suite only                               |
| `make test-impl`    | Implementation suite only                            |
| `make check`        | Types, format, lint, typecheck, and both suites      |
| `make dev`          | Build the site, then `wrangler dev` on port 8787     |
| `make site-dev`     | `astro dev` with HMR, for the look of the front page |
| `make site-build`   | Build the site to `site/dist`                        |
| `make fmt`          | Format in place                                      |
| `make watch`        | Tests in watch mode                                  |
| `make build-client` | Build `@horse-holder/client` to `client/ts/dist`     |
| `make example`      | Run the client examples against a live server        |

`make dev` and `make site-dev` trade off against each other. The Astro adapter's platform proxy
cannot instantiate a Durable Object defined in the same Worker, so under `astro dev` every page
renders and `/keys` issues keys, but the endpoints that draw on a budget do not work. Use
`site-dev` for the look of the pages, and `dev` for anything that touches a budget. `make
test-spec` builds the site first, since the Worker it boots serves both.

`site/wrangler.dev.jsonc` is why `site-dev` boots without warnings: it is the bindings config
the platform proxy reads, identical to `site/wrangler.jsonc` minus the Durable Object that only
the deployed Worker can export.

## Using it

Issue a key, then send it as a bearer token:

```bash
curl -XPOST localhost:8787/v1/keys
# {"accountId":"acct_...","apiKey":"hh_sk_..."}

curl -XPOST localhost:8787/v1/charge \
  -H "authorization: Bearer hh_sk_..." \
  -H "hh-group: storage" \
  -H "idempotency-key: $(uuidgen)" \
  -H "content-type: application/json" \
  -d '{"budgets":[{"id":"r2-put-ops","amount":1,
        "definition":{"limit":1000000,"warnings":[0.8],
          "renewal":{"type":"calendar","unit":"month","timezone":"America/Chicago"}}}]}'
```

### From TypeScript

[client/ts/](client/ts/) is a zero-dependency client for the protocol. It is written against
[the specification](spec/spec.md) rather than against this server, so it has no notion of
`/v1/keys` or anything else this deployment adds on top, and pointing `baseUrl` at any
conforming implementation is the whole of the porting effort.

The client's primary object is a **group**, since a group is the atomicity domain and the only
thing a request can address. Declare one with its budgets, then draw:

```ts
import { HorseHolderClient, renewal } from "@horse-holder/client";

const hhldr = new HorseHolderClient({ baseUrl, apiKey });

const storage = hhldr.group({
  id: "storage",
  budgets: {
    "r2-put-ops": {
      limit: 1_000_000,
      warnings: [0.8],
      renewal: renewal.monthly({ timezone: "America/Chicago" }),
    },
  },
});

const result = await storage.charge({ "r2-put-ops": 1 }, { idempotencyKey: uploadId });
if (!result.ok) {
  console.warn(`blocked, retry in ${result.retryAfter}s`);
}
```

A `402` is a returned value rather than a thrown error, because running out of budget is the
protocol working as designed. See [client/ts/README.md](client/ts/README.md) for reservations,
tenants, retries, and errors, and [examples/](examples/) for seven runnable examples: `make dev`
in one terminal, `make example` in another.

## Implementation choices

The protocol leaves some values to the implementation. Ours:

| Choice                  | Value                                                |
| ----------------------- | ---------------------------------------------------- |
| Authentication          | Bearer API key, SHA-256 hashed in KV, one scope each |
| Default reservation TTL | 300 seconds                                          |
| Maximum reservation TTL | 86,400 seconds                                       |
| Idempotency retention   | 24 hours                                             |
| Settled hold retention  | 24 hours, so a repeat settle can replay              |
| Budgets per draw        | 16                                                   |

Expiry, renewal, and reclamation are all driven off deadline heaps rather than timers, so they
happen as a consequence of the next request rather than on a schedule. An idle group costs
nothing and a busy one pays only for what actually came due. Idempotency records are the one
thing not held in memory: they are looked up by exact key and never enumerated, so keeping a
day of them resident would tie cold-start latency to traffic instead of to the number of
budgets.

## The conformance suite

[tests/spec/](tests/spec/) is a standalone suite that speaks only HTTP, one file per area of the
protocol. Nothing in it references API keys, KV, or Durable Objects; it imports only the two
scaffolding files beside it:

| File                                 | Does                                            |
| ------------------------------------ | ----------------------------------------------- |
| [tests/setup.ts](tests/setup.ts)     | Starts a server for the run, or defers to a URL |
| [tests/harness.ts](tests/harness.ts) | Mints a fresh scope on it                       |
| [tests/client.ts](tests/client.ts)   | The request vocabulary the tests are written in |

The first two are the whole of what is implementation-specific.

By default `make test-spec` boots our server with `wrangler dev` on port 8799 and runs against
it. Point it at any other Horse Holder implementation instead:

```bash
HH_BASE_URL=https://budgets.example.com make test-spec
```
