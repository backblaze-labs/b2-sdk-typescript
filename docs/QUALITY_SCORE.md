# Quality score

A candid, per-domain read on how battle-tested each part of the SDK is, and where
the known soft spots are. This is contributor/maintainer signal — it must **not**
leak into user-facing docs (see the docs policy in [`../AGENTS.md`](../AGENTS.md)).

Grades: **A** solid, well-tested, few surprises · **B** good, some edges untested ·
**C** works but under-exercised or newer. Grades are judgment, not a metric.

## Repo-wide gates (enforced in CI)

- Coverage floor: **97% statements · 98% lines · 97% functions · 92% branches**
  (`vitest.coverage.config.ts`).
- `pnpm lint` is `--error-on-warnings`; `pnpm docs` treats TypeDoc warnings as errors.
- Suite runs on Node 22/24 (Linux/Windows/macOS), Bun (`bun test src/`), and real
  Chromium/Firefox/WebKit — the same `*.test.ts` files, everywhere.

## By domain

| Domain | Grade | Notes |
|---|---|---|
| `raw/` (31 native endpoints) | A | 1:1 wire bindings with simulator parity; percent-encoding covered. |
| `http/` (transport, retry, SSRF) | A | Retry math, 401 reauth, Retry-After, `B2SsrfError` all exercised with injected sleep. |
| `upload/` (small/large/resume/stream) | A | Multi-MB round-trips + per-part SHA-1; resume discovery and explicit `resumeFileId`. |
| `download/` (parallel ranged) | A | Per-range retry under injected transient 503s. |
| `copy/` (server-side multipart) | A | `copyLargeFile` orchestration via `b2_copy_part`. |
| `auth/` (in-memory + file) | A | Realm locking, upload-URL pool checkout/evict; file backend is Node-only. |
| `streams/` (SHA-1, sources, SSE-C) | A | Node/WebCrypto backends; `EncryptionKey` redaction verified. |
| `simulator/` | A | Isomorphic, monotonic timestamps; the whole suite depends on it. |
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
- **No recorded-wire snapshot fixtures** — simulator parity is hand-maintained.
- **Native API doc drift** is a standing risk, mitigated (not eliminated) by the
  guardrails in design-doc 0002.
