# Quality score

A candid, per-domain read on how battle-tested each part of the SDK is, and where
the known soft spots are. This is contributor/maintainer signal — it must **not**
leak into user-facing docs (see the docs policy in [`../AGENTS.md`](../AGENTS.md)).

Grades: **A** solid, well-tested, few surprises · **B** good, some edges untested ·
**C** works but under-exercised or newer. Grades are judgment, not a metric.

## Repo-wide gates

- Coverage floor: **97% statements · 98% lines · 97% functions · 92% branches**
  (`vitest.coverage.config.ts`). Removing the embedded server and its dependent
  suites reduced the current result to **statements 80.88% · lines 81.55% ·
  functions 77.64% · branches 74.87%**, so this gate is red until replacement
  tests restore the lost coverage.
- `pnpm lint` is `--error-on-warnings`; `pnpm docs` treats TypeDoc warnings as errors.
- Suite runs on Node 22/24 (Linux/Windows/macOS), Bun (`bun test src/`), and real
  Chromium/Firefox/WebKit — the same `*.test.ts` files, everywhere.

## By domain

| Domain | Grade | Notes |
|---|---|---|
| Core client, bucket, and object facades | C | Main workflows lost broad round-trip coverage; focused constructor and helper tests remain. |
| `raw/` (31 native endpoints) | B | 1:1 wire bindings; request construction and percent-encoding covered. |
| `http/` (transport, retry, SSRF) | A | Retry math, 401 reauth, Retry-After, `B2SsrfError` all exercised with injected sleep. |
| `upload/` (small/large/resume/stream) | C | Resume helpers remain covered; core upload and stream paths lost round-trip coverage. |
| `download/` (parallel ranged) | B | Parallel range planning and retries use focused transport fakes; single-download coverage is thin. |
| `copy/` (server-side multipart) | C | Public orchestration remains implemented but has no in-repo behavioral suite. |
| `auth/` (in-memory + file) | B | Upload-URL pool and cache validation remain covered; file round trips lost coverage. |
| `streams/` (SHA-1, sources, SSE-C) | A | Node/WebCrypto backends; `EncryptionKey` redaction verified. |
| `notifications/` (webhook sig) | A | Signature verify + `requireValidWebhook`. |
| `errors/` + `types/` | A | Hierarchy + `classifyError`; branded IDs. A few edge branches sit at the floor. |
| `sync/` | B | B2↔B2 works in browser (lazy fs); local-disk paths are Node-only and less varied. |
| `s3/` | B | Presign helpers covered; depth is narrower than the native path. |
| `partner/` | B | Redaction + reserve-trial covered; fewer live shapes than core. |
| `backup/` (`bz_`) | C | Newest module; live behavior is entitlement-gated (403 "not entitled"), so live coverage is thin. Quirks recorded in [design-docs/0002](design-docs/0002-native-api-docs-drift-guardrails.md). |

## Known soft spots

Tracked with owners and next steps in
[`exec-plans/tech-debt-tracker.md`](exec-plans/tech-debt-tracker.md). Headlines:

- **Branch coverage** sits near the 92% floor in a few error/edge paths.
- **No mutation / property / fuzz testing** yet — coverage proves execution, not
  assertion strength.
- **No recorded-wire snapshot fixtures** — wire parity relies on live evidence
  and hand-maintained fixtures.
- **No in-repo end-to-end test backend** — removing the embedded server dropped
  broad storage workflow coverage until the standalone server is wired in.
- **Native API doc drift** is a standing risk, mitigated (not eliminated) by the
  guardrails in design-doc 0002.
