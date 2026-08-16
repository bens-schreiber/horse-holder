API := pnpm --filter @horse-holder/api exec
SITE := pnpm --filter @horse-holder/site exec
SPEC := pnpm --filter @horse-holder/spec-tests exec
STAMP := node_modules/.install-stamp

.PHONY: build-client check clean default deploy-dry-run deploy-production deploy-staging dev example fmt fmt-check install lint lint-fix site-build site-dev smoke test test-impl test-spec typecheck types watch

default: test

$(STAMP): pnpm-lock.yaml pnpm-workspace.yaml package.json api/package.json tests/package.json client/ts/package.json
	pnpm install
	@mkdir -p node_modules && touch $(STAMP)

install: $(STAMP)

api/worker-configuration.d.ts: $(STAMP) api/wrangler.jsonc
	$(API) wrangler types

types: api/worker-configuration.d.ts

# Every project typechecks from source, so nothing here needs a build first.
typecheck: api/worker-configuration.d.ts
	pnpm exec tsc --noEmit -p api/tsconfig.json
	pnpm exec tsc --noEmit -p tests/tsconfig.json
	pnpm exec tsc --noEmit -p client/ts/tsconfig.json
	pnpm exec tsc --noEmit -p site/tsconfig.json

# Builds @horse-holder/client to client/ts/dist. Plain tsc, no bundler.
build-client: $(STAMP)
	pnpm exec tsc -p client/ts/tsconfig.json

fmt: $(STAMP)
	pnpm exec oxfmt .

fmt-check: $(STAMP)
	pnpm exec oxfmt --check .

lint: $(STAMP)
	pnpm exec oxlint

lint-fix: $(STAMP)
	pnpm exec oxlint --fix

test: test-impl test-spec

# The vendor-neutral suite. Boots our server on port 8799 by default; set HH_BASE_URL to run
# the same tests against another implementation instead. One Worker serves the site and the
# API, so the suite needs the site built before it can boot one.
test-spec: site-build
	$(SPEC) vitest run

test-impl: api/worker-configuration.d.ts
	$(API) vitest run

watch: api/worker-configuration.d.ts
	$(API) vitest

# Durable Objects need a real Worker, which means a built site and no HMR. Use `site-dev` for
# working on the look of the static pages; use this for anything touching `/v1/*`.
dev: site-build
	$(SITE) wrangler dev --port $(PORT)

# HMR for the static pages. The adapter's platform proxy cannot instantiate a Durable Object
# defined in this same Worker, so `/v1/*` does not work here.
site-dev: $(STAMP)
	$(SITE) astro dev

site-build: $(STAMP)
	$(SITE) astro build

# CI calls these, but they are plain wrangler: export a scoped CLOUDFLARE_API_TOKEN and you can run
# the identical deploy from a laptop. Each environment is its own Worker script with its own KV
# namespace and Durable Object storage, so these never touch each other's state.
deploy-staging: site-build
	$(SITE) wrangler deploy --env staging

deploy-production: site-build
	$(SITE) wrangler deploy --env production

# Typechecks the Worker config and bundles the script without contacting Cloudflare, so a broken
# wrangler.jsonc fails on a PR instead of at deploy time. Needs the site built first because
# site/worker.ts imports ./dist/_worker.js/index.js.
deploy-dry-run: site-build
	$(SITE) wrangler deploy --env production --dry-run

# Post-deploy verification, run against a live deployment. Needs no credentials: `/` proves the
# asset binding is serving the built site, and an unrouted /v1/ path proves the Worker script itself
# executed, since that 404 body comes from api/src/serve.ts and not from the asset handler.
smoke:
	@test -n "$(URL)" || { echo "smoke: set URL=https://<host>"; exit 1; }
	@curl -fsS -o /dev/null -w "smoke: GET / -> %{http_code}\n" "$(URL)/"
	@curl -sS "$(URL)/v1/__smoke" | grep -q "unknown endpoint" \
		|| { echo "smoke: $(URL)/v1/__smoke did not return the Worker's 404 body"; exit 1; }
	@echo "smoke: ok"

# The client's test surface: tests/examples/run.ts drives every file in examples/ts and asserts
# none of them threw. Needs a live server, so it is not part of `check`: run `make dev` in
# another terminal first. The driver issues a fresh API key per run unless HORSEHOLDER_API_KEY
# is already set.
PORT ?= 8787

example: build-client
	HH_BASE_URL="http://127.0.0.1:$(PORT)" $(SPEC) node --experimental-strip-types examples/run.ts

check: types fmt-check lint typecheck test

clean:
	rm -rf node_modules api/node_modules tests/node_modules client/ts/node_modules \
		client/ts/dist api/.wrangler api/worker-configuration.d.ts
