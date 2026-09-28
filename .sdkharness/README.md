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
