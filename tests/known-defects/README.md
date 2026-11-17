# Known-defect tests

Each test here asserts the **correct** behaviour of something that is still
defective on `main`, so every test in this directory currently fails. They live
outside `src/` on purpose: the default `pnpm test`, `bun test src/`, the browser
run and the coverage run never collect them, so CI stays green while the
defects stay visible and runnable.

```bash
pnpm build                  # the example-program tests spawn the built package
pnpm test:known-defects     # exits non-zero until every defect here is fixed
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
routes `fetch` into the in-memory simulator so an unmodified example runs
offline. Several tests pin implementation details beyond the defect itself (for
example exact message text or the HTTP status used); adjust them with the fix if
the corrected behaviour is legitimately different.
