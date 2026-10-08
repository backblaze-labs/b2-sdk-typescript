# sdkharness contract

`tests.tsv` exposes repository-owned quality checks to the centralized
[`sdkharness`](https://github.com/backblaze-labs/demand-side-ai/tree/main/sdkharness)
orchestrator. The contract is versioned with this repository so the harness
executes checks that match the SDK revision under test.

`health/examples` (`tests/health-examples`) is the same built-package example smoke used by
`.github/workflows/examples.yml`. Its target is `offline` because it uses this
SDK's in-memory `B2Simulator`; it does not exercise real B2 or sdkharness's HTTP
simulator.

`health/golden-path` (`tests/health-golden-path`) exercises authorize, upload, byte-verified download, list,
delete, and post-delete absence through sdkharness's shared HTTP simulator. It
refuses a non-loopback target and a non-fixed credential (see "Guard rules"
below) before it builds or sends anything. The harness initially runs both checks only as non-counting
shadow evidence.

The `conformance/*` checks define this SDK's executable behavior against the
shared simulator. The `resilience/*` checks define its recovery behavior under
faults injected through that simulator's control API. Both sets import this
checkout through its package self-reference, so `dist/` must have been built
from the same revision before they run. The `run-conformance` and
`run-resilience` dispatchers validate the loopback-only simulator contract and
translate each check's standing verdict into the five-field
`SDKHARNESS_RESULT` record consumed by the orchestrator.

Run each resilience scenario against a fresh `--control` simulator. The simulator keeps one
request journal with no reset and the checks count it, so `run-resilience` reports a simulator
that already served requests as a `configuration` FAIL instead of letting an earlier scenario's
requests produce a false SDK verdict.

## Testing a published release

A published package ships no sources, so `pnpm build` cannot run in it. To test a
release, install it (`npm pack @backblaze-labs/b2-sdk@X`, extract,
`npm install --omit=dev --ignore-scripts`), copy this `.sdkharness/` into the
extracted tree and set `SDKHARNESS_SDK_PREBUILT=1`. The health checks then skip
`pnpm build` if the files the `exports` map names for `.` exist, and fail with a
clear message if they do not. With the variable unset the checks build exactly as
before. `health/examples` also needs the repository's `examples/` and `tsx`, so it
is not meaningful against a published tree.

## Guard rules

Every check, the two dispatchers and `health-golden-path` share one guard,
`tests/lib/guard.cjs` (shell side: `tests/lib/contract.sh`):

- **Simulator origin.** Only `http://127.0.0.1:<port>` (IPv4 literal, plain
  HTTP). The TLS listener, where a check needs it, is only
  `https://127.0.0.1:<port>`. `[::1]`, `localhost`, any other host, userinfo, a
  path or a query is refused as a `FAIL` `configuration` before anything is dialed.
- **Credential.** Only the simulator's fixed pair, `test-key-id` / `test-key`.
  `health-golden-path` refuses anything else.
- **Proxies.** `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and
  `NODE_USE_ENV_PROXY` (either case) are unset by the dispatchers, the health
  check and every leaf, so a developer or CI proxy cannot reroute loopback traffic.
- **Amber is narrow.** `COULD-NOT-RUN` is allowed only when the SDK build is
  missing (`dist/` has no file for the import), and the leaf must exit `0`; the
  dispatchers turn a nonzero exit after `COULD-NOT-RUN` into `FAIL`. A built SDK
  that throws on import is a `FAIL`.
- **Refusals are specific.** A check that proves "the SDK refused this" asserts the
  expected error (type, status, code, message), not any thrown error.

The guard's own tests run with `pnpm run test:sdkharness` (`node --test`, no
simulator or build needed).

## Run one check locally

From a checkout of this repository, with the loopback simulator from the
`sdkharness` tree (`<sdkharness>/bin/simulator/serve.mjs`; `--control` adds the
fault-control listener the resilience checks need):

```bash
# 1. Start the simulator on loopback (leave it running; it prints its URLs).
node <sdkharness>/bin/simulator/serve.mjs --control > /tmp/sim.log 2>&1 &
cat /tmp/sim.log
#   SIMULATOR-LISTENING http://127.0.0.1:<port>
#   SIMULATOR-LISTENING https://127.0.0.1:<port>
#   SIMULATOR-CONTROL http://127.0.0.1:<port>

# 2. Build this exact checkout; the checks import it through its package name.
pnpm install --frozen-lockfile && pnpm build

# 3. Point the dispatcher at the simulator.
export SDKHARNESS_SIMULATOR_URL=http://127.0.0.1:<port>
export SDKHARNESS_SIMULATOR_HTTPS_URL=https://127.0.0.1:<port>   # urls.* only
export SDKHARNESS_SIMULATOR_CA=<sdkharness>/bin/simulator/loopback-cert.pem
export SDKHARNESS_SIMULATOR_CONTROL_URL=http://127.0.0.1:<port>  # resilience only

# 4. Run one scenario through its dispatcher.
SDKHARNESS_TEST_LEVEL=conformance SDKHARNESS_SCENARIO=files.upload \
  ./.sdkharness/tests/run-conformance
SDKHARNESS_TEST_LEVEL=resilience SDKHARNESS_SCENARIO=upload.retry_503 \
  ./.sdkharness/tests/run-resilience

# 5. Health (the harness pre-creates the bucket; create one on the simulator
#    first, with the fixed credential, and name it here).
SDKHARNESS_TEST_LEVEL=health SDKHARNESS_SCENARIO=golden-path \
  HEALTHCHECK_REALM_URL="$SDKHARNESS_SIMULATOR_URL" \
  B2_TEST_APPLICATION_KEY_ID=test-key-id B2_TEST_APPLICATION_KEY=test-key \
  B2_BUCKET_NAME=<bucket> ./.sdkharness/tests/health-golden-path

# 6. Stop the simulator.
kill %1
```

The last line of output is the `SDKHARNESS_RESULT` record
(`level<TAB>scenario<TAB>PASS|FAIL|SKIP<TAB>reason`); the lines before it are
the check's own output. To see a leaf's raw standing verdict, run it directly with
the matching `CONFORMANCE_*` / `RESILIENCE_*` variables, for example
`CONFORMANCE_TARGET=simulator CONFORMANCE_SIMULATOR_URL=http://127.0.0.1:<port> ./.sdkharness/tests/conformance/files.upload.cjs`.
Only loopback URLs and the fixed credential are accepted; never point these at a
real B2 realm.
