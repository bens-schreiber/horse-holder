# @horse-holder/api

A conforming [Horse Holder v1](../spec/spec.md) server on Cloudflare Workers and Durable
Objects. This directory is self-contained: it deploys on its own, and nothing in it imports
from `site/`.

```
src/index.ts     Worker entry: the fetch handler, and the BudgetGroup export the binding names
src/serve.ts     Routing, validation, and RPC dispatch. The whole handler
src/auth.ts      Bearer API keys, one scope each
src/budget.ts    BudgetGroup DO: all protocol semantics, reached by RPC
src/expiry.ts    The deadline heap that drives expiry, renewal, and reclamation
src/schema.ts    Headers, paths, codes, zod request schemas, error envelope
src/renewal.ts   Renewal rules and their boundary math (timezones, DST, clamping)
```

`serve.ts` deliberately contains no value import from `budget.ts`. The Durable Object class
reaches for `cloudflare:workers`, which resolves only inside workerd, so importing it would
make the handler unloadable anywhere else. `index.ts` is the one file that wires the two
together, which is what lets the website import `serve.ts` and supply its own entry.

## Deploying it standalone

You need a Cloudflare account and `wrangler login`. The only stateful resource is one KV
namespace for API key hashes; Durable Objects are created on demand.

```bash
pnpm install

# Create the KV namespace and put the id it prints into wrangler.jsonc,
# replacing "api_keys_placeholder".
pnpm --filter @horse-holder/api exec wrangler kv namespace create API_KEYS

pnpm --filter @horse-holder/api exec wrangler deploy
```

That publishes a Worker serving `/v1/*` at your `workers.dev` subdomain, or at whatever route
you add to `wrangler.jsonc`. Then issue a key and use it:

```bash
curl -XPOST https://your-worker.workers.dev/v1/keys
# {"accountId":"acct_...","apiKey":"hh_sk_..."}
```

Run it locally with `wrangler dev` from this directory; `make dev` at the repo root runs the
website's Worker instead, which serves this same API alongside the site.

## Relationship to the website

`site/` is an optional front end. It does not re-implement anything: it imports `serve.ts` and
re-exports `BudgetGroup` from its own Worker entry so that one deployment serves both the pages
and `/v1/*`. Deploying this directory alone gives you the full API and no website. Deploying
`site/` gives you both. There is no configuration in which the API depends on the site.
