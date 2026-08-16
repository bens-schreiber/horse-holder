# Horse Holder

A conforming [Horse Holder v1](spec/spec.md) server — pre-flight budget enforcement over
HTTP — on Cloudflare Workers and Durable Objects.

One Durable Object per `(scope, tenant, group)` triple, which is the transactional unit §8.1
recommends, so the protocol's atomicity requirements hold structurally rather than by careful
request handling. The Worker validates every request and reaches the storage tier only by
typed RPC, so nothing downstream re-parses the wire format.

## Layout

```
api/src/index.ts       Worker: routing, validation, and RPC dispatch
api/src/auth.ts        Our §9 extension: bearer API keys, one scope each
api/src/budget.ts      BudgetGroup DO: all protocol semantics, reached by RPC
api/src/schema.ts      Headers, paths, codes, zod request schemas, error envelope
api/src/renewal.ts     Renewal rules and their boundary math (timezones, DST, clamping)
tests/spec/            Protocol conformance suite — implementation-agnostic
tests/*.ts             Its scaffolding: server setup, harness, HTTP client
api/tests/impl/        Our extensions and internals
docs/                  Documented values and interpretations
```

## Commands

Everything runs from the `Makefile` at the repo root; there is no `scripts` block in any
`package.json`.

| Command          | Does                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| `make test`      | Both suites (the default target)                                         |
| `make test-spec` | Conformance suite only                                                   |
| `make test-impl` | Implementation suite only                                                |
| `make check`     | Types, format, lint, typecheck, and both suites — the definition of done |
| `make dev`       | `wrangler dev`, for manual smoke testing                                 |
| `make fmt`       | Format in place                                                          |
| `make watch`     | Tests in watch mode                                                      |

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

See [docs/implementation-notes.md](docs/implementation-notes.md) for the TTL and retention
values the spec requires us to publish, the authentication scheme, and the interpretations
this server makes.

## The conformance suite

[tests/spec/](tests/spec/) is a standalone suite that speaks only HTTP, one file per spec
section. Nothing in it references API keys, KV, or Durable Objects; it imports only the two
scaffolding files beside it:

| File                                 | Does                                             |
| ------------------------------------ | ------------------------------------------------ |
| [tests/setup.ts](tests/setup.ts)     | Starts a server for the run, or defers to an URL |
| [tests/harness.ts](tests/harness.ts) | Mints a fresh scope on it                        |
| [tests/client.ts](tests/client.ts)   | Headers of §2 and bodies of §5 — protocol only   |

The first two are the whole of what is implementation-specific.

By default `make test-spec` boots our server with `wrangler dev` and runs against it. Point
it at any other Horse Holder implementation instead:

```bash
HH_BASE_URL=https://budgets.example.com make test-spec
```
