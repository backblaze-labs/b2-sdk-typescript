# Testing

Choose checks for the behavior changed and report what each check establishes.
The existing rules and setup are in [AGENTS.md](../AGENTS.md),
[CONTRIBUTING.md](../CONTRIBUTING.md), and [REVIEW.md](../REVIEW.md).

## Test levels

| Level | Command | Evidence and limits |
| --- | --- | --- |
| Unit and simulator | `pnpm test` | Exercises SDK behavior against the in-memory simulator; it does not prove live B2 behavior. |
| Browser | `pnpm test:browser` | Exercises shared tests in browser engines; see AGENTS.md for setup. |
| Live integration | `pnpm test:integration` | Exercises real B2 with the configured credential profiles; tests can skip without credentials. |
| Known defects | `pnpm test:known-defects` | Builds and runs the separate known-defect suite; unresolved defects are expected to fail. See its [README](../tests/known-defects/README.md). |
| Examples | `pnpm typecheck:examples` | Typechecks cookbook examples; it does not execute them against B2. |

Run `pnpm verify` for the repository gate described in AGENTS.md. The example
program regression tests in the known-defect suite also execute examples against
the simulator; typechecking alone does not prove their runtime behavior.

## Show that a test pins a fix

Run the regression test against the old behavior and record the failure. After
implementing the fix, run it again and record the pass. To check an existing fix,
temporarily revert the relevant change in an isolated checkout and rerun the
test: it must fail for the intended reason. Restore the fix and rerun it. If it
still passes or fails for an unrelated reason, improve the test. REVIEW.md asks
reviewers to check that tests fail when the change is reverted.

## When to use live B2

Add or extend a live integration test when the change depends on B2 service
behavior, such as a changed request or response contract, authentication,
Object Lock, encryption, or multipart behavior. Simulator tests cannot establish
how B2 responds. Pure local logic, documentation, and test infrastructure changes
usually need no live test. See CONTRIBUTING.md for the simulator's limits and
AGENTS.md for credential profiles and destructive-test opt-ins.

## Report results

List each check and its result with enough output to identify what ran. Mark a
skipped, unavailable, or unexecuted check **NOT RUN**, never passed. Give the
reason and state what remains unverified, such as live B2 behavior without
credentials. Do not describe a skipped integration suite as a live pass.
