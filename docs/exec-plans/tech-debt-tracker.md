# Tech-debt tracker

Standing list of known, deliberate deferrals — the things a fresh agent would
otherwise "discover" and re-litigate. Each entry says what, why it's deferred, and
the next concrete step. Close an entry by linking the PR that resolves it.

Issue tracker: <https://github.com/backblaze-labs/b2-sdk-typescript/issues> ·
current milestone: **v0.4.0**.

| # | Item | Status | Next step |
|---|---|---|---|
| 1 | **Branch-coverage headroom** — a few error/edge branches sit at the 92% floor. | Tracked ([#273](https://github.com/backblaze-labs/b2-sdk-typescript/issues/273)) | Add targeted edge-path tests (e.g. `types/file.ts`); raise the gate only after the slack exists. |
| 2 | **Native API doc drift** — B2 docs and live behavior disagree in places. | Mitigated | When the native docs repo becomes accessible, move or report the [design-doc 0002](../design-docs/0002-native-api-docs-drift-guardrails.md) findings upstream. |
| 3 | **No mutation / property-based / fuzz testing.** | Deferred | Coverage proves execution, not assertion strength. Pilot mutation testing on `raw/` + `http/` first. |
| 4 | **No recorded-wire snapshot fixtures.** | Deferred | Simulator parity is hand-maintained; capture sanitized real-B2 responses as golden fixtures for the raw client. |
| 5 | **Backup (`bz_`) live coverage is thin** — entitlement-gated (403 "not entitled"). | Accepted | Keep live probes as clean skips; expand simulator-side backup cases instead of relying on live runs. |

## Conventions

- One row per deferral; keep it short. Detail that needs more than a sentence gets
  its own file under [`active/`](active/) and a link from here.
- "Deferred" = decided not-now. "Mitigated" = risk reduced, not gone. "Accepted" =
  living with it by design.
- When an item ships, move its detail (if any) to [`completed/`](completed/) and
  strike the row with the resolving PR.
