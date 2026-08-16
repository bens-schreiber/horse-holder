API := pnpm --filter @horse-holder/api exec
SPEC := pnpm --filter @horse-holder/spec-tests exec
STAMP := node_modules/.install-stamp

.PHONY: default install types typecheck fmt fmt-check lint lint-fix test test-spec test-impl watch dev check clean

default: test

$(STAMP): package.json pnpm-workspace.yaml api/package.json tests/package.json
	pnpm install
	@mkdir -p node_modules && touch $(STAMP)

install: $(STAMP)

types: $(STAMP)
	$(API) wrangler types

api/worker-configuration.d.ts: $(STAMP) api/wrangler.jsonc
	$(API) wrangler types

typecheck: api/worker-configuration.d.ts
	pnpm exec tsc --noEmit -p api/tsconfig.json
	pnpm exec tsc --noEmit -p tests/tsconfig.json

fmt: $(STAMP)
	pnpm exec oxfmt .

fmt-check: $(STAMP)
	pnpm exec oxfmt --check .

lint: $(STAMP)
	pnpm exec oxlint

lint-fix: $(STAMP)
	pnpm exec oxlint --fix

test: test-impl test-spec

# The vendor-neutral suite. Boots our server by default; set HH_BASE_URL to point it at
# another implementation instead.
test-spec: $(STAMP)
	$(SPEC) vitest run

test-impl: api/worker-configuration.d.ts
	$(API) vitest run

watch: api/worker-configuration.d.ts
	$(API) vitest

dev: api/worker-configuration.d.ts
	$(API) wrangler dev

check: types fmt-check lint typecheck test

clean:
	rm -rf node_modules api/node_modules tests/node_modules api/.wrangler api/worker-configuration.d.ts
