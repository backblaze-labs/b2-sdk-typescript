# Releasing `@backblaze-labs/b2-sdk`

How to cut a new version of `@backblaze-labs/b2-sdk`, publish it to npm, and produce a matching GitHub Release.

The flow is **tag-driven**: you bump the version with `pnpm version`, which also dates the changelog and creates a `v<version>` git tag; pushing that tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which builds, publishes to npm via **OIDC trusted publishing** (no `NPM_TOKEN`), and creates the GitHub Release. The changelog is maintained by hand under a `## [Unreleased]` heading (Keep a Changelog style) and promoted automatically on each bump.

> If anything here conflicts with what's actually in [`package.json`](package.json) or [`.github/workflows/`](.github/workflows/), trust the config and fix the doc.

---

## Prerequisites

1. **An npm account** that is a member of the `@backblaze-labs` org with publish rights to `@backblaze-labs/b2-sdk`.
   - Confirm with `npm whoami` and `npm access ls-collaborators @backblaze-labs/b2-sdk` (after the first publish).
2. **Two-factor authentication enabled** on your npm account. Required for the manual first publish and any `@backblaze-labs`-scoped package.
3. **`pnpm` 11+** locally. Install via `corepack enable && corepack prepare pnpm@11.1.0 --activate`.
4. **Push access to `main`** and permission to create tags + GitHub Releases.

Automated releases use OIDC trusted publishing (no secret to manage); you configure it once on npmjs.com after 0.1.0 ships, see [Configure trusted publishing](#3-configure-trusted-publishing-after-010-is-live).

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

There is **no `NPM_TOKEN` secret to create or rotate.** The `id-token: write` permission in `release.yml` is what lets pnpm mint a short-lived, single-use credential at publish time.

> **Requirements for the OIDC path:** Node ≥ 22.14.0 (the workflow's `node-version: 22` resolves above this) and pnpm ≥ 11.0 for native OIDC publish (pinned via `packageManager`).

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

## Keeping the changelog updated

The changelog is a [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) file with a `## [Unreleased]` section at the top.

**As part of any PR that changes behaviour, add a bullet under `## [Unreleased]`**, grouped under the appropriate heading (`### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Security`). Write it for a user, in the past tense, focused on *why* it matters:

```markdown
## [Unreleased]

### Added

- Resume multipart uploads after a crash with the new `resume: true` option.

### Fixed

- Range download retries no longer drop bytes when the transport reuses buffers.
```

That's the whole discipline. At release time, `pnpm version` promotes everything under `## [Unreleased]` into a dated `## [<version>]` section and leaves a fresh empty `## [Unreleased]` behind (via [`scripts/cut-changelog.mjs`](scripts/cut-changelog.mjs), wired to the `version` lifecycle script). If `[Unreleased]` is empty when you bump, the script warns so you notice a release with no notes.

> Tip: a CI check that fails a PR touching `src/` without a corresponding `## [Unreleased]` edit keeps this honest. Not enforced today; add one if entries start getting forgotten.

---

## Pre-flight checklist

Run the full local gate before releasing (CI runs it too, but catching it locally is faster):

```bash
pnpm install --frozen-lockfile
pnpm run verify     # lint + lint:docs + lint:spelling + typecheck + typecheck:examples
                    # + test + build + docs + verify:metadata + verify:release + verify:exports
```

`pnpm run verify` must exit `0`. For extra confidence on the published artifact:

```bash
pnpm test:coverage  # coverage gate (>= 95% statements)
pnpm test:browser   # real Chromium + Firefox + WebKit via Playwright
pnpm pack --pack-destination /tmp && tar -tzf /tmp/backblaze-labs-b2-sdk-*.tgz | sort
```

The tarball should contain `dist/` (`.js` / `.cjs` / `.d.ts` / `.d.cts` per entry), `README.md`, `LICENSE`, `CHANGELOG.md`, and **nothing** from `src/`, `coverage/`, or `node_modules/`. `pnpm run verify:exports` already asserts the dual-format type resolution.

---

## Releasing (the normal flow, 0.1.1 onward)

From a clean, up-to-date `main`:

```bash
git checkout main && git pull --ff-only
pnpm run verify                      # green gate

pnpm version patch                   # or `minor` / `major`
#  -> bumps package.json version
#  -> runs the `version` lifecycle script: cut-changelog promotes
#     [Unreleased] -> [<version>] - <date>, then `git add CHANGELOG.md`
#  -> commits package.json + CHANGELOG.md and creates the tag v<version>

git push --follow-tags               # pushes the version commit AND the tag
```

Pushing the tag fires [`.github/workflows/release.yml`](.github/workflows/release.yml), which:

1. Checks out the tag and verifies the tag matches `package.json` version.
2. Runs the gate (`lint`, `typecheck`, `test`, `build`, `verify:metadata`, `verify:release`, `verify:exports`) and immediately packs/uploads that verified artifact. `attw` is informational, pinned, and runs through `npx` in a separate job that never creates the npm artifact or enters the build job dependency graph.
3. `pnpm publish` over OIDC (skipped only if the version is already on the registry with matching integrity). Provenance is attested automatically.
4. Creates the GitHub Release using the matching `CHANGELOG.md` section as the body (via `scripts/extract-changelog.mjs`).

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

---

## Pre-releases (alpha, beta, rc)

```bash
pnpm version prerelease --preid rc   # 0.1.1 -> 0.1.2-rc.0 (re-run bumps to rc.1, ...)
git push --follow-tags
```

Prereleases are detected by the hyphen in the version. `cut-changelog` **leaves `## [Unreleased]` intact** (the notes describe the eventual stable release), and `release.yml` publishes to the **`next`** dist-tag and marks the GitHub Release as a pre-release. `latest` is untouched.

Users opt in with `pnpm add @backblaze-labs/b2-sdk@next`. Ship the stable cut later with a normal `pnpm version patch|minor|major`, which then promotes the accumulated `[Unreleased]` notes.

---

## After-the-fact corrections

| Situation | Action |
|---|---|
| Bad version on npm (broken types/build) | Publish a patch on top. **Do not** unpublish — npm forbids it after 72 h and it breaks downstream lockfiles. |
| Truly compromised version (secret leaked) | `npm deprecate '@backblaze-labs/b2-sdk@<version>' '<reason>'`, then publish a fixed patch. Coordinate with security if a key leaked. |
| Tag points at the wrong commit | Delete local + remote tag, retag the right commit, force-push: `git push --force origin v<version>`. Then re-run the release via `workflow_dispatch`. |
| GitHub Release body is wrong | Edit it on the GitHub UI, or re-run the release workflow (it re-uses the changelog section). |
| Forgot a changelog entry before tagging | Fix `CHANGELOG.md` on `main`, then `gh release edit v<version> --notes-file <(node scripts/extract-changelog.mjs <version>)`. |

---

## Checklist (TL;DR)

- [ ] `## [Unreleased]` in `CHANGELOG.md` reflects everything since the last release
- [ ] `pnpm install --frozen-lockfile` clean
- [ ] `pnpm run verify` green (optionally `pnpm test:coverage` + `pnpm test:browser`)
- [ ] `pnpm version <patch|minor|major>` produces a sensible `CHANGELOG.md` diff + tag
- [ ] `git push --follow-tags`
- [ ] Release workflow green: npm publish + GitHub Release created
- [ ] `npm view @backblaze-labs/b2-sdk version` shows the new version
- [ ] Smoke test from a fresh `pnpm add @backblaze-labs/b2-sdk` passes
