# Thin wrappers over the pnpm scripts, for cross-repo `make ci` parity.
# pnpm is the source of truth; see AGENTS.md and CONTRIBUTING.md.
.PHONY: ci verify test lint build

ci: verify ## Run the full local gate that CI mirrors.

verify:
	pnpm run verify

test:
	pnpm test

lint:
	pnpm run lint

build:
	pnpm run build
