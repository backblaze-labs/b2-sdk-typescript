# sdkharness contract

`tests.tsv` exposes repository-owned quality checks to the centralized
[`sdkharness`](https://github.com/backblaze-labs/demand-side-ai/tree/main/sdkharness)
orchestrator. The contract is versioned with this repository so the harness
executes checks that match the SDK revision under test.

`health/examples` is the same built-package example smoke used by
`.github/workflows/examples.yml`. Its target is `offline` because it uses this
SDK's in-memory `B2Simulator`; it does not exercise real B2 or sdkharness's HTTP
simulator.

`health/golden-path` exercises authorize, upload, byte-verified download, list,
delete, and post-delete absence through sdkharness's shared HTTP simulator. It
refuses a non-loopback target and reads only the fixed test credentials supplied
by the harness. The harness initially runs both checks only as non-counting
shadow evidence.

The `conformance/*` checks define this SDK's executable behavior against the
shared simulator. The `resilience/*` checks define its recovery behavior under
faults injected through that simulator's control API. Both sets import this
checkout through its package self-reference, so `dist/` must have been built
from the same revision before they run. The `run-conformance` and
`run-resilience` dispatchers validate the loopback-only simulator contract and
translate each check's standing verdict into the five-field
`SDKHARNESS_RESULT` record consumed by the orchestrator.

## Run one check locally

Nothing here touches B2. You need Node 22+ and pnpm.

```bash
# 1. Build this checkout (the checks import it through its package self-reference)
pnpm install --frozen-lockfile && pnpm build

# 2. A local simulator (any one of these; it needs access to backblaze-labs/b2-simulator)
git clone https://github.com/backblaze-labs/b2-simulator /tmp/b2-simulator
node /tmp/b2-simulator/bin/simulator/serve.mjs --control > /tmp/sim.out &    # prints the URLs
# ...or use the simulator embedded in the harness: sdkharness/bin/simulator/serve.mjs

# 3. Read the URLs it printed
export SDKHARNESS_SIMULATOR_URL=$(sed -n 's/^SIMULATOR-LISTENING \(http:.*\)/\1/p' /tmp/sim.out)
export SDKHARNESS_SIMULATOR_HTTPS_URL=$(sed -n 's/^SIMULATOR-LISTENING \(https:.*\)/\1/p' /tmp/sim.out)
export SDKHARNESS_SIMULATOR_CONTROL_URL=$(sed -n 's/^SIMULATOR-CONTROL \(.*\)/\1/p' /tmp/sim.out)
export SDKHARNESS_SIMULATOR_CA=/tmp/b2-simulator/bin/simulator/loopback-cert.pem
```

The standalone simulator also exports the same values as `B2SIM_URL`,
`B2SIM_HTTPS_URL`, `B2SIM_CONTROL_URL` and `B2SIM_CA` (its `bin/lib/simulator.sh`
helper); the checks read the `SDKHARNESS_SIMULATOR_*` names above.

```bash
# conformance (one capability)
SDKHARNESS_TEST_LEVEL=conformance SDKHARNESS_SCENARIO=files.upload .sdkharness/tests/run-conformance

# resilience (one injected fault; needs the control URL, i.e. serve.mjs --control)
SDKHARNESS_TEST_LEVEL=resilience SDKHARNESS_SCENARIO=api.backoff_503 .sdkharness/tests/run-resilience

# customer health (needs a bucket in the simulator first)
node --input-type=module -e "
import { B2Client } from '@backblaze-labs/b2-sdk'
const client = new B2Client({ applicationKeyId: 'test-key-id', applicationKey: 'test-key', realm: process.env.SDKHARNESS_SIMULATOR_URL, allowedHostSuffixes: [] })
await client.authorize()
await client.createBucket({ bucketName: 'sdkharness-healthcheck', bucketType: 'allPrivate' })
"
HEALTHCHECK_REALM_URL=$SDKHARNESS_SIMULATOR_URL B2_TEST_APPLICATION_KEY_ID=test-key-id \
  B2_TEST_APPLICATION_KEY=test-key B2_BUCKET_NAME=sdkharness-healthcheck \
  .sdkharness/tests/health-golden-path
```

Each dispatcher prints one `SDKHARNESS_RESULT` line and refuses any simulator URL that
is not `http://127.0.0.1:<port>`. A leaf that prints `COULD-NOT-RUN` but exits nonzero
is reported as a failure, not a skip (`pnpm run test:sdkharness-dispatchers`). The
`urls.native_download` check works with either simulator (it reads the fixture host from the
pinned CA, see below). Known SDK findings (for example
`large.multipart` and the connection-fault resilience scenarios) fail by design.

`conformance/urls.native_download` addresses a loopback fixture hostname because
the SDK builds native share URLs only on Backblaze download hosts. The embedded
harness simulator and the standalone B2 simulator carry different fixture names
in their certificates, so `tests/lib/fixture-host.cjs` picks the one the pinned
CA actually names and fails loudly when it names none.
