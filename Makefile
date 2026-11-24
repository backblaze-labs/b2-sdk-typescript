# Thin wrappers over the pnpm scripts, for cross-repo `make ci` parity.
# pnpm is the source of truth; see AGENTS.md and CONTRIBUTING.md.
.PHONY: ci verify test lint build changelog-check changelog-new

ci: verify changelog-check ## Run the full local gate that CI mirrors.

# CHANGELOG.md must match what changie generates from .changes/.
changelog-check:
	pnpm run changelog:check

changelog-new:
	pnpm run changelog:new

verify:
	pnpm run verify

test:
	pnpm test

lint:
	pnpm run lint

build:
	pnpm run build
