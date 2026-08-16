API := pnpm --filter @horse-holder/api exec
SPEC := pnpm --filter @horse-holder/spec-tests exec
STAMP := node_modules/.install-stamp

.PHONY: build-client check clean default dev example fmt fmt-check install lint lint-fix test test-impl test-spec typecheck types watch

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
# the same tests against another implementation instead.
test-spec: $(STAMP)
	$(SPEC) vitest run

test-impl: api/worker-configuration.d.ts
	$(API) vitest run

watch: api/worker-configuration.d.ts
	$(API) vitest

dev: api/worker-configuration.d.ts
	$(API) wrangler dev --port $(PORT)

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
