# Known-defect tests

Each test here asserts the **correct** behaviour of something that is still
defective on `main`, so every test in this directory currently fails. They live
outside `src/` on purpose: the default `pnpm test`, `bun test src/`, the browser
run and the coverage run never collect them, so CI stays green while the
defects stay visible and runnable.

A few tests are deliberate boundary controls (for example a stream of exactly
10,000 parts still succeeds). They pass today and exist so that an early failure
in the code under test cannot satisfy a neighbouring validation test; keep them
when moving the file.

```bash
pnpm test:known-defects     # builds first (the example-program tests spawn the built package);
                            # exits non-zero until every defect here is fixed
```

`pnpm run typecheck:known-defects` (part of `pnpm verify`) keeps the files
compiling against the current API.

## When a defect is fixed

1. Run the test; it should now pass.
2. Move the test (without the `known-defect` part of the file name) next to the
   code it covers, for example `src/http/retry.test.ts`, so it joins the default
   suite and protects the fix. Fix its relative imports.
3. Delete the empty file here. Delete `helpers/` and this README when nothing is
   left.

The example-program tests depend on `helpers/fetch-simulator-preload.mjs`, which
routes `fetch` to the standalone b2-simulator the test started (its origins in
`B2SIM_API_URL` and `B2SIM_CONTROL_URL`) so an unmodified example runs
offline. Several tests pin implementation details beyond the defect itself (for
example exact message text or the HTTP status used); adjust them with the fix if
the corrected behaviour is legitimately different.
