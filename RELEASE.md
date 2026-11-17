# Releasing `@backblaze-labs/b2-sdk`

How to cut a new version of `@backblaze-labs/b2-sdk`, publish it to npm, and produce a matching GitHub Release.

The flow is **tag-driven**. pnpm/npm owns `package.json` versions; the version lifecycle asks Changie to assemble fragments for that exact version. The release goes through a PR before a maintainer tags its approved merge commit. Pushing a `v<version>` tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which checks release policy and security triage, builds a verified artifact, publishes with **npm OIDC trusted publishing and provenance**, and creates the GitHub Release. Changie owns only changelog content; it does not bump package versions or publish.

> If anything here conflicts with what's actually in [`package.json`](package.json) or [`.github/workflows/`](.github/workflows/), trust the config and fix the doc.

---

## Prerequisites

1. **An npm account** that is a member of the `@backblaze-labs` org with publish rights to `@backblaze-labs/b2-sdk`.
   - Confirm with `npm whoami` and `npm access ls-collaborators @backblaze-labs/b2-sdk` (after the first publish).
2. **Two-factor authentication enabled** on your npm account. Required for the manual first publish and any `@backblaze-labs`-scoped package.
3. **`pnpm` 11+** locally. Install via `corepack enable && corepack prepare pnpm@11.1.0 --activate`.
4. **A GitHub CLI login with release security access**, and permission to create release PRs, milestones, tags and GitHub Releases.
5. **Git 2.34+, GPG and OpenSSH** on the verification host (the release runner includes them). Maintainers can sign with either GPG or SSH. Signing-key enrollment is described below; enforcement is initially off.

npm publication uses OIDC trusted publishing (no npm credential secret); configure it once on npmjs.com, see [Configure trusted publishing](#3-configure-trusted-publishing-after-010-is-live). The separate GitHub security-read credential is described under the release security gate.

---

## First-time setup (one-time, before 0.1.0)

### 1. Reserve the npm org

```bash
npm login                                     # log in as the org owner
open https://www.npmjs.com/org/create         # create @backblaze-labs (Free is fine); skip if it exists
npm whoami                                    # confirm your account
```

### 2. Publish 0.1.0 manually (the first release can't use OIDC)

A trusted publisher is configured *per package* on npmjs.com, and you can't configure one for a package that doesn't exist yet. So the very first publish has to be a manual one that creates the package. The 0.1.0 changelog is already cut, so:

```bash
git checkout main && git pull --ff-only
pnpm install --frozen-lockfile
pnpm run verify                               # full local gate (see Pre-flight checklist)
pnpm publish --access public                  # creates @backblaze-labs/b2-sdk@0.1.0 (prompts for OTP)
npm view @backblaze-labs/b2-sdk version       # -> 0.1.0
```

Then tag it and create the GitHub Release by hand (the workflow isn't involved yet):

```bash
git tag -a v0.1.0 -m v0.1.0
git push origin v0.1.0
gh release create v0.1.0 --title v0.1.0 \
  --notes-file <(node scripts/extract-changelog.mjs 0.1.0)
```

> Pushing `v0.1.0` will trigger `release.yml`. That's fine: its publish step is idempotent and **skips** when the version is already on npm after confirming the registry artifact matches the verified tarball. For the one-time manual bootstrap only, a workflow dispatch rerun can set `allow_registry_artifact_mismatch` if the manually published artifact is intentionally different and the GitHub Release still needs to be created. If you'd rather avoid the run entirely, disable the Release workflow in the Actions tab during the bootstrap and re-enable it after.

### 3. Configure trusted publishing (after 0.1.0 is live)

Now wire up OIDC so every future release publishes from CI with zero secrets:

1. **npmjs.com → `@backblaze-labs/b2-sdk` → Settings → Trusted publishing → add a GitHub Actions publisher:**
   - **Organization or user**: `backblaze-labs`
   - **Repository**: `b2-sdk-typescript`
   - **Workflow filename**: `release.yml`
   - **Environment**: leave blank (the workflow declares none)
   - **Allowed actions**: `npm publish`
2. (Recommended) flip the package to **Require two-factor authentication and disallow tokens**. OIDC keeps working; classic/automation tokens stop, closing off the most common supply-chain leak.

There is **no `NPM_TOKEN` secret to create or rotate.** The `id-token: write` permission in `release.yml` is what lets the npm CLI mint a short-lived, single-use credential at publish time.

> **Requirements for the OIDC path:** npm CLI ≥ 11.5.1 and Node ≥ 22.14.0 for trusted publishing itself. The artifact build job pins Node 22.22.2 so the repo toolchain matches its JSDoc lint floor, while the publish-only job uses Node 24 so the GitHub-hosted runner carries npm 11 for trusted publishing. pnpm remains pinned via `packageManager` for install/build/test steps.

<details>
<summary>Fallback: token-based publishing (only if you can't use OIDC)</summary>

If trusted publishing isn't an option (self-hosted runner, an unsupported CI provider), add an automation token:

1. <https://www.npmjs.com/settings/~/tokens> → **Generate New Token → Granular Access Token**, scoped to `@backblaze-labs/*` (Read and write) + org `@backblaze-labs` (Read).
2. `gh secret set NPM_TOKEN --repo backblaze-labs/b2-sdk-typescript --body '<token>'`
3. In `release.yml`, add `env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }` to the publish step.

A long-lived token can be exfiltrated, so prefer trusted publishing wherever it's supported.

</details>

---

## Versioning policy

`@backblaze-labs/b2-sdk` follows [Semantic Versioning](https://semver.org/). The bump you pass to `pnpm version` decides the new number:

| Change type | Examples | `pnpm version` arg | Bump |
|---|---|---|---|
| Bug fix, no public-API change | retry math fix, simulator typo | `patch` | `0.1.0 -> 0.1.1` |
| Backwards-compatible feature | new bucket method, new error subclass, new subpath export | `minor` | `0.1.1 -> 0.2.0` |
| Breaking change | renamed method, removed export, changed return shape | `major` | `0.2.0 -> 1.0.0` |

While below `1.0.0`, breaking changes are allowed in `minor` bumps per the standard semver convention, but call them out clearly in the changelog under a `### Changed` / `### Removed` heading.

---

## Changelog fragments

Changie **1.24.0** is pinned as a development dependency, so `pnpm install`
provides the same generator locally and in CI. The fragment layout follows
[Blazer](https://github.com/Backblaze/blazer/blob/main/.changie.yaml); the separate
release preflight follows the approach documented by
[Genblaze](https://github.com/backblaze-labs/genblaze/blob/main/RELEASING.md).

The `v0.5.0` tag is not an ancestor of `main`; compare the released trees when interpreting `v0.5.0..v0.6.0`.

Add a fragment with each user-facing change:

```bash
pnpm changelog:new
```

Choose Added, Changed, Deprecated, Removed, Fixed, or Security. Keep the note
focused on the caller's resulting behavior and migration, and commit the YAML
under `.changes/unreleased/` with its PR. Unpublished advisory details belong in
the private advisory, never in a public fragment or issue.

`CHANGELOG.md` is generated from the version archives in `.changes/`; do not edit
it or maintain a hand-written Unreleased section. `pnpm changelog:merge` rebuilds
it and `pnpm changelog:check` checks for drift. Released archives must retain
their content unless a correction is explained in the PR.

The existing notes through v0.5.0 are imported from their published history.
Pending fragments describe changes after that release, including the pending
release preparation. Review the fragments against the published tag before batching.

pnpm/npm remains the version owner. After it changes `package.json`, the `version`
lifecycle runs `changie batch v<package.json version>` and `changie merge`, then
stages the changelog and fragment changes. There are no Changie version replacements.
The hook rejects an empty stable release or a version older than released history.
A prerelease bump retains the pending stable fragments; see the prerelease section.

## Signing-key enrollment and rollout

The intended maintainers in [`.github/signing-maintainers`](.github/signing-maintainers)
are `goanpeca`, `ffumero2003`, and `sophiecarreras`. The gate resolves their current
public GPG keys from `https://github.com/<username>.gpg` and SSH keys from
`https://github.com/<username>.keys`. It also reads GitHub's public SSH signing-key
API because keys registered only for signing are separate from the `.keys` feed.
Verification uses a temporary keyring and allowed-signers file, never a personal keyring.
No private keys belong in this repository or its workflow secrets.

**Enrollment phase:** `ENFORCE_SIGNED_TAGS` is unset by default. The job runs
`git verify-tag`, reports missing keys or invalid signatures as warnings, and
continues. Security triage and milestone readiness are still mandatory.

Before enabling enforcement, each listed maintainer must:

1. Create a personal GPG or SSH signing key and register the public key on their
   GitHub account. For SSH, select the **Signing Key** type. Never upload the private key.
2. Configure Git to sign with that key. For GPG, set `user.signingkey` to the key's
   fingerprint and `gpg.format` to `openpgp`; for SSH, set `gpg.format` to `ssh` and
   `user.signingkey` to the signing key's public-key path.
3. Verify a signed test tag using the gate, then confirm every listed maintainer
   has at least one enrolled key. Keep fixture keys outside the real repository.
4. Have a maintainer enable the repository Actions variable:

   ```bash
   gh variable set ENFORCE_SIGNED_TAGS --body true --repo backblaze-labs/b2-sdk-typescript
   ```

With the variable set to `true`, unsigned, unknown-signer, unreadable-key-source,
or invalid-signature results fail this workflow's verification job. Do not enable it before enrollment.
To check a real release tag locally after it exists:

```bash
ENFORCE_SIGNED_TAGS=true pnpm release:tag vX.Y.Z
```

CI loads the roster and policy from the default branch, inspects the requested
tag, and passes its exact commit to the build. The build does not resolve the
mutable tag name again.

The variable controls CI verification; it is not a repository authorization rule.
Repository-wide publishing enforcement additionally requires tag-creation rulesets
for approved `v*` tags and a protected release environment restricted to those
protected tags, with the npm trusted publisher bound to that environment. An
administrator must coordinate those settings and the publish-job environment
binding before relying on repository-wide enforcement. This change preserves the
existing OIDC publisher configuration and does not configure those external controls.

## Release milestone discipline

Create one milestone named exactly `vX.Y.Z` when planning the release. Assign its
issues and PRs, including the release PR, to that milestone. Public fixes use
public issues; unpublished security work stays in its private advisory.

Before tagging, all intended changes must be merged and the milestone must have
**zero open issues and pull requests**. The workflow checks every API page and
fails if the milestone is missing, unreadable, or still has open work. A maintainer
must decide whether deferred work belongs in a later release; do not close work
merely to make the gate pass.

Readiness is a tagging/publishing prerequisite. An open release PR may correctly
keep the milestone check on hold during preparation.

Keep the milestone open until publication and the installed-package smoke check
are complete, then close it. An already closed milestone with no open work is
accepted for an idempotent workflow rerun.

```bash
pnpm release:milestone vX.Y.Z
```

## Release security gate

`pnpm run verify` checks quality and release-tool behavior; it is **not** a live
security-triage approval. Run the separate gate before tagging:

```bash
pnpm release:security vX.Y.Z
```

The release workflow runs the same gate before it can build or publish:

| Source | Holds the release when |
| --- | --- |
| Code scanning | Any alert is open on the default branch. |
| Dependabot | An open alert has a patched version. |
| Secret scanning | Any alert is open. |
| Repository security advisories | A triage advisory or an unapproved draft remains open. |

Dependency alerts without a patched version are reported as notes; record their
triage and owner decision before release. Fix or formally dismiss actionable
findings with a written reason through the appropriate security workflow. The gate
never dismisses, changes labels, or closes alerts itself.

Configure the Actions secret `RELEASE_SECURITY_TOKEN` with a GitHub App token or
fine-grained token held by a maintainer/security manager who can read all four
sources for this repository. Grant only the required read permissions: Code
scanning alerts, Dependabot alerts, Secret scanning alerts, and Repository security
advisories. This is a GitHub read credential, not an npm publishing credential.
The default `GITHUB_TOKEN` may lack these permissions. Missing access, security
feature availability, malformed data, or API failures are **UNVERIFIED** and hold
the release; an empty readable list is the only clear result. Output contains
counts and states, never secret values, unpublished summaries or private advisory IDs.

When this release fixes a draft advisory that must remain private until tagging,
a security maintainer records approval privately and sets the optional
`RELEASE_SECURITY_APPROVAL` Actions secret to JSON with `tag` (exact `vX.Y.Z`) and
`advisories` (the approved draft IDs). The exemption applies only to that tag and
to draft state; triage advisories still hold. Confirm the fixes in the release PR
without copying private identifiers into it, publish those advisories immediately
after the release, then clear the approval secret.

This does not change npm authentication: the publish job retains OIDC, provenance,
its existing pinned actions, and its prohibition on executing repository code.

---

## Pre-flight checklist

Run the full local gate before releasing (CI runs it too, but catching it locally is faster):

```bash
pnpm install --frozen-lockfile
pnpm run verify
bash .sdkharness/tests/health-examples
pnpm release:security vX.Y.Z
pnpm release:milestone vX.Y.Z
```

`pnpm run verify` must exit `0`. The local health command builds the SDK and runs the example lifecycle against its in-memory simulator; it needs no live B2 credentials. The HTTP golden-path check additionally needs the harness-provided simulator and environment described in [`.sdkharness/README.md`](.sdkharness/README.md). For extra confidence on the published artifact:

```bash
pnpm test:coverage  # coverage gate: 97% statements, 98% lines, 97% functions, 92% branches
pnpm test:browser   # real Chromium + Firefox + WebKit via Playwright
pnpm pack --pack-destination /tmp && tar -tzf /tmp/backblaze-labs-b2-sdk-*.tgz | sort
```

For live Backblaze B2 confidence, also verify that the relevant commit has a
green `Integration (real B2)` workflow run, or manually dispatch that workflow
before tagging. The release workflow does not run `pnpm test:integration`, so a
successful publish gate alone does not prove the SDK has just passed against the
real B2 service.

The tarball should contain `dist/` (`.js` / `.cjs` / `.d.ts` / `.d.cts` per entry), `README.md`, `LICENSE`, `CHANGELOG.md`, and **nothing** from `src/`, `coverage/`, or `node_modules/`. `pnpm run verify:exports` already asserts the dual-format type resolution.

---

## Releasing (the normal flow, 0.1.1 onward)

From a clean, up-to-date `main`, after planning the release milestone and reviewing triage:

```bash
git switch -c release/vX.Y.Z origin/main
pnpm install --frozen-lockfile
pnpm exec changie latest --skip-prereleases   # check the published-history floor
pnpm version X.Y.Z --no-git-tag-version       # manifest version changes; Changie only renders notes
pnpm run verify
bash .sdkharness/tests/health-examples
```

Choose the next version explicitly from the latest release and its compatibility
changes; do not assume a stale development manifest is the latest published version.
Review `package.json`, `.changes/`, and `CHANGELOG.md`, commit them, and open the
release PR with its milestone, changelog, verification and human review request.
Do not create a release tag during PR preparation.

After approval and merge, rerun the security and milestone checks. Milestone
readiness is expected to hold while the release PR is still open. Once both
checks pass, tag the release PR's merge commit, which may no longer be the tip of main:

```bash
git fetch origin main --tags
release_commit=$(gh pr view <release-pr> --json mergeCommit --jq .mergeCommit.oid)
git log -1 --oneline "$release_commit"
git tag -s vX.Y.Z "$release_commit" -m "Release X.Y.Z"
ENFORCE_SIGNED_TAGS=true pnpm release:tag vX.Y.Z
git push origin refs/tags/vX.Y.Z
```

During the warning-only enrollment phase, a maintainer without an enrolled key
may use `git tag -a` instead of `git tag -s` and run `pnpm release:tag vX.Y.Z`
without enforcement. The workflow warns; it does not block on enrollment.
Once `ENFORCE_SIGNED_TAGS=true`, only verified maintainer-signed tags pass the
checks in this workflow. Repository-wide enforcement also requires the tag rules
and environment protections described above.
Never move or delete a published tag.

Pushing the tag fires [`.github/workflows/release.yml`](.github/workflows/release.yml), which:

1. Uses the configured workflow gates to load trusted policy from the default branch, verify the tag under the enrollment/enforcement mode, check milestone/security readiness, and pin artifact checkout to the inspected commit. The tag must match `package.json`. Repository-wide enforcement depends on the tag rulesets and protected-environment binding described above.
2. Runs the quality gate (`lint`, `typecheck`, `test`, `build`, `verify:metadata`, `verify:release`, `verify:exports`) and immediately packs/uploads that verified artifact. `attw` is informational, pinned, and runs through `npx` in a separate job that never creates the npm artifact or enters the build job dependency graph.
3. `npm publish` over OIDC (skipped only if the version is already on the registry with matching integrity). Provenance is attested automatically.
4. Creates the GitHub Release using the matching `CHANGELOG.md` section as the body (via `scripts/extract-changelog.mjs`).

The release workflow intentionally stays packaging-focused. Treat the separate
`Integration (real B2)` workflow as the live-service signal for PR, scheduled,
manual, and release-readiness checks.

Then confirm:

```bash
npm view @backblaze-labs/b2-sdk version      # the new version
npm view @backblaze-labs/b2-sdk dist-tags    # latest: <version>
```

If you ever need to re-run a release for an existing tag, use the workflow's **Run workflow** button (`workflow_dispatch`) and pass the tag, e.g. `v0.1.1`.

### Smoke test the published package

```bash
mkdir /tmp/b2-smoke && cd /tmp/b2-smoke && pnpm init -y
pnpm add @backblaze-labs/b2-sdk@latest
node --input-type=module -e "
  import { B2Client, VERSION } from '@backblaze-labs/b2-sdk'
  import { B2Simulator } from '@backblaze-labs/b2-sdk/simulator'
  console.log('VERSION =', VERSION)
  const sim = new B2Simulator()
  const c = new B2Client({ applicationKeyId: 'k', applicationKey: 'k', transport: sim.transport() })
  await c.authorize()
  console.log('authorize OK, accountId =', c.accountInfo.getAccountId())
"
```

Before publishing, smoke the packed tarball that was produced from the bumped
checkout. This verifies the runtime `VERSION` matches the installed package
manifest, resolves every public subpath including `/partner` and `/backup`
through both ESM and CJS, and contains no source or secret-bearing paths such
as `src/`, `coverage/`, `node_modules/`, `.env`, or `.npmrc`:

```bash
pnpm pack --pack-destination /tmp/b2-smoke
pnpm run smoke:published -- /tmp/b2-smoke/backblaze-labs-b2-sdk-<version>.tgz
```

After `npm view @backblaze-labs/b2-sdk dist-tags` shows `latest: <version>`,
repeat the same acceptance smoke against the registry:

```bash
pnpm run smoke:published -- @backblaze-labs/b2-sdk@latest
```

The helper imports the installed artifact in subprocesses with a scrubbed
environment, throwaway HOME/cache directories, Node filesystem permissions
limited to the temp project, child processes/workers disabled, and common Node
network APIs blocked. Keep it out of credentialed release jobs; it is intended
for maintainer acceptance checks after the release artifact or registry package
is available.

---

## Pre-releases (alpha, beta, rc)

```bash
pnpm version X.Y.Z-rc.0 --no-git-tag-version
# npm owns the new prerelease version; render a preview without consuming stable fragments:
prerelease_version=$(node -p "require('./package.json').version")
pnpm exec changie batch "v$prerelease_version" --keep
pnpm changelog:merge
pnpm run verify
```

Commit the preview in a release PR with its matching milestone. After merge,
use the same tag/signature, security and milestone gates as stable releases.
A hyphenated version publishes to the **`next`** dist-tag and creates a prerelease
on GitHub; `latest` is untouched. The version lifecycle retains pending stable
fragments, and the explicit preview keeps them with `--keep`. The eventual stable
`pnpm version X.Y.Z --no-git-tag-version` batches them normally. Users opt in with
`pnpm add @backblaze-labs/b2-sdk@next`.

---

## After-the-fact corrections

| Situation | Action |
|---|---|
| Bad version on npm (broken types/build) | Publish a patch on top. **Do not** unpublish — npm forbids it after 72 h and it breaks downstream lockfiles. |
| Truly compromised version (secret leaked) | `npm deprecate '@backblaze-labs/b2-sdk@<version>' '<reason>'`, then publish a fixed patch. Coordinate with security if a key leaked. |
| Published tag points at the wrong commit | Keep the published tag immutable and prepare a corrected patch release. |
| GitHub Release body is wrong | Edit it on the GitHub UI, or re-run the release workflow (it re-uses the changelog section). |
| Forgot a changelog entry before tagging | Explain the correction in a PR, update its released `.changes/v<version>.md` archive and run `pnpm changelog:merge`. A maintainer can then update the GitHub Release notes. |

---

## Checklist (TL;DR)

- [ ] Intended work and release PR belong to the exact `vX.Y.Z` milestone
- [ ] Main CI and relevant live integration are green
- [ ] Changie fragments cover the changes and explain compatibility/migration
- [ ] pnpm/npm selects the version without creating a tag during PR preparation
- [ ] `pnpm install --frozen-lockfile` and `pnpm run verify` pass
- [ ] `bash .sdkharness/tests/health-examples` passes locally
- [ ] Separate security triage passes; no UNVERIFIED checks remain
- [ ] Milestone has no open issues or PRs before tagging
- [ ] Human approves the release PR; tag its merge commit
- [ ] Signing keys are enrolled before `ENFORCE_SIGNED_TAGS` is enabled
- [ ] Publish only through the existing tag-driven npm OIDC/provenance workflow
- [ ] Smoke the installed artifact, publish any privately approved fixed advisories, and close the milestone
