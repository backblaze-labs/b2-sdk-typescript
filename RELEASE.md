# Releasing `@backblaze-labs/b2-sdk`

How to cut a new version of `@backblaze-labs/b2-sdk`, publish it to npm, and produce a matching GitHub Release.

The project uses [changesets](https://github.com/changesets/changesets) for versioning + changelog generation, [pnpm](https://pnpm.io/) for the package manager, and [GitHub Actions](https://docs.github.com/en/actions) for CI. Releases are scoped (`@backblaze-labs/`) and published as `public` packages.

> If anything in this document conflicts with what is actually configured in [`.changeset/config.json`](.changeset/config.json), [`package.json`](package.json), or [`.github/workflows/`](.github/workflows/), trust the config and fix the doc.

---

## Prerequisites

Before your first release, make sure you have:

1. **An npm account** that is a member of the `@backblaze-labs` org with publish rights to `@backblaze-labs/b2-sdk`.
   - Confirm with `npm whoami` and `npm access ls-collaborators @backblaze-labs/b2-sdk` (after the first publish).
2. **Two-factor authentication enabled** on your npm account. Required for the manual first publish and for any `@backblaze-labs`-scoped package.
3. **`pnpm` 11+** locally. Install via `corepack enable && corepack prepare pnpm@11.1.0 --activate`.
4. **Push access to `main`** and permission to create tags + GitHub Releases.

Automated releases use **OIDC trusted publishing** (no `NPM_TOKEN` secret); you configure that once on npmjs.com after 0.1.0 ships. See [Configure trusted publishing](#3-configure-trusted-publishing-after-010-is-live).

Optional but recommended:

- [`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io) installed globally (`npm i -g @arethetypeswrong/cli`) for a sanity check on the `exports` map. The release workflow already runs this — install locally only if you want to reproduce a CI failure on your machine.

---

## First-time setup (one-time, before 0.1.0)

These steps are only needed before the **first** publish to npm. After that, normal releases follow the flow below.

### 1. Reserve the npm scope

If `@backblaze-labs` doesn't yet exist as an npm organization:

```bash
# Log in as the user who will own the org.
npm login

# Create the org. Pick a billing plan: "Free" for public packages is fine.
# Skip if the org already exists; just add yourself as a member instead.
open https://www.npmjs.com/org/create
```

Once the org exists, invite collaborators and verify your membership:

```bash
npm whoami                                    # should match your account
npm org ls @backblaze-labs                    # should list you (after the first publish)
```

### 2. Publish 0.1.0 manually (the first release can't use OIDC)

`release.yml` publishes via **OIDC trusted publishing** — no `NPM_TOKEN` secret. But a trusted publisher is configured *per package* on npmjs.com, and you can't configure one for a package that doesn't exist yet. So the **first** publish has to be a manual one that creates the package:

Follow [Releasing — the recommended manual flow](#releasing--the-recommended-manual-flow). It uses `npm login` + `pnpm publish` from your laptop (you see the OTP prompt and the tarball contents yourself). No CI token is involved.

### 3. Configure trusted publishing (after 0.1.0 is live)

Once `@backblaze-labs/b2-sdk` exists on npm, wire up OIDC so every future release publishes from CI with zero secrets:

1. Go to **npmjs.com → `@backblaze-labs/b2-sdk` → Settings → Trusted publishing**.
2. Add a **GitHub Actions** publisher:
   - **Organization or user**: `backblaze-labs`
   - **Repository**: `b2-sdk-typescript`
   - **Workflow filename**: `release.yml`
   - **Environment**: leave blank (the workflow declares none)
   - **Allowed actions**: `npm publish`
3. (Recommended) flip the package to **Require two-factor authentication and disallow tokens**. OIDC keeps working; classic/automation tokens stop working, closing off the most common supply-chain leak.

That's it. There is **no `NPM_TOKEN` secret to create or rotate.** The `id-token: write` permission already declared in `release.yml` is what lets pnpm mint a short-lived, single-use credential at publish time.

> **Requirements for the OIDC path:** Node ≥ 22.14.0 (the workflow's `node-version: 22` resolves above this) and pnpm ≥ 11.0 for native OIDC publish (pinned via `packageManager` in `package.json`). If you ever switch the publish step to the npm CLI, that needs npm ≥ 11.5.1.

<details>
<summary>Fallback: token-based publishing (only if you can't use OIDC)</summary>

If trusted publishing isn't an option (self-hosted runner, a CI provider npm doesn't support yet), fall back to an automation token:

1. <https://www.npmjs.com/settings/~/tokens> → **Generate New Token → Granular Access Token**, scoped to `@backblaze-labs/*` (Read and write) + org `@backblaze-labs` (Read).
2. `gh secret set NPM_TOKEN --repo backblaze-labs/b2-sdk-typescript --body '<token>'`
3. In `release.yml`, add `NPM_TOKEN: ${{ secrets.NPM_TOKEN }}` back to the `env:` of the changesets step and add `--provenance` to the publish command.

This is strictly less secure than OIDC (a long-lived token that can be exfiltrated), so prefer trusted publishing wherever it's supported.

</details>

---

## Versioning policy

`@backblaze-labs/b2-sdk` follows [Semantic Versioning](https://semver.org/):

| Change type | Examples | Bump |
|---|---|---|
| Bug fix that does not alter the public API | retry math correction, simulator handler typo | `patch` (`0.1.0 -> 0.1.1`) |
| Backwards-compatible new feature | new bucket method, new error subclass, new subpath export | `minor` (`0.1.1 -> 0.2.0`) |
| Breaking change to a public type or runtime behaviour | renamed method, removed export, changed return shape | `major` (`0.2.0 -> 1.0.0`) |

While the package is below `1.0.0`, breaking changes are allowed in `minor` bumps per the standard semver convention, but please call them out clearly in the changeset.

---

## Recording a change with changesets

**Every PR that touches `src/` must include a changeset.** A changeset is a short markdown file under `.changeset/` that captures what changed and at which bump level. Forgetting one means the release will have no entry in the changelog.

```bash
pnpm changeset
```

The CLI walks you through:

1. Which packages are affected (only `@backblaze-labs/b2-sdk` exists today, so this is automatic).
2. The bump type: `patch`, `minor`, or `major`.
3. A short human-readable summary that lands in `CHANGELOG.md` verbatim.

Write the summary in past tense, ~1 sentence, focused on **why** the change matters to a user. Examples:

- ✅ `Resume multipart uploads after a crash with the new resume: true option.`
- ✅ `Fix range download retries dropping bytes when the inner transport reuses buffers.`
- ❌ `update bucket.ts`
- ❌ `add tests`

Commit the generated `.changeset/<slug>.md` file with the rest of your change.

---

## Pre-flight checklist

Run these locally before tagging a release. CI also runs them on every push, but doing it locally first catches issues before the release commit lands on `main`.

```bash
pnpm install --frozen-lockfile

pnpm lint           # Biome
pnpm lint:docs      # ESLint JSDoc/TSDoc completeness
pnpm typecheck      # tsc --noEmit (strict + exactOptionalPropertyTypes)
pnpm test           # Node test suite (uses in-memory simulator)
pnpm test:coverage  # Coverage gate (≥ 95% statements; fails otherwise)
pnpm test:browser   # Real Chromium + Firefox + WebKit via Playwright
pnpm run docs       # TypeDoc — treats warnings as errors
pnpm build          # ESM + CJS + DTS for every subpath export

# Optional but recommended: check the published types are resolvable
# from every common module resolution strategy.
npx -p @arethetypeswrong/cli attw --pack .
```

Every command above must exit `0`. If `attw` reports issues, fix them before publishing; broken types reach users immediately.

---

## Releasing — the recommended manual flow

This is the flow to use for the first few releases until you trust the automation. All commands run from a clean `main` checkout.

> **0.1.0 note.** The first release was hand-cut: `package.json` was bumped from `0.0.0` to `0.1.0` and the `[Unreleased]` block in `CHANGELOG.md` was renamed to `## [0.1.0] - 2026-05-28` in the same commit. There are **no queued changesets** for 0.1.0, so skip step 1 below and jump to step 2 (commit) or step 3 (build) — depending on whether the version commit is already on `main`.

### 1. Apply queued changesets

```bash
git checkout main
git pull --ff-only

pnpm changeset version
```

This consumes every `.changeset/*.md` file, bumps `package.json` `version` according to the highest bump level present, and rewrites `CHANGELOG.md` with the accumulated entries. **Review the diff carefully** — `CHANGELOG.md` is what users will read.

### 2. Commit the version bump

```bash
git add package.json CHANGELOG.md .changeset/
git commit -m "release: v$(node -p "require('./package.json').version")"
```

Keep this commit separate from feature work so the tag points at a single, pure version commit.

### 3. Final build + verification

```bash
pnpm install --frozen-lockfile   # picks up the new version in package.json
pnpm run clean
pnpm build                        # `prepublishOnly` also runs this, but doing it twice is cheap
pnpm pack --pack-destination /tmp # produces backblaze-labs-b2-sdk-<version>.tgz; inspect contents
tar -tzf /tmp/backblaze-labs-b2-sdk-*.tgz | sort
```

Check that the tarball contains:

- `package/dist/index.{js,cjs,d.ts,d.cts}`
- One pair per subpath export (`raw`, `errors`, `auth`, `auth/file`, `streams`, `sync`, `simulator`, `s3`)
- `package/README.md`, `package/LICENSE`, `package/CHANGELOG.md`
- **No** `__screenshots__/`, `coverage/`, `src/`, or `node_modules/`. If any of those show up, the `files` field in `package.json` or `.gitignore` is wrong; fix before publishing.

### 4. Publish to npm

```bash
pnpm publish --access public --provenance
```

Flag-by-flag:

- `--access public` — scoped packages default to private; npm refuses to publish without this on a public scope.
- `--provenance` — generates a [Sigstore](https://docs.npmjs.com/generating-provenance-statements) attestation linking the published tarball to its GitHub Actions build. Optional locally, required on CI.

You'll be prompted for your npm OTP. After the publish succeeds:

```bash
npm view @backblaze-labs/b2-sdk version           # should print the new version
npm view @backblaze-labs/b2-sdk dist-tags          # should show `latest: <version>`
```

### 5. Tag and push

```bash
VERSION=$(node -p "require('./package.json').version")
git tag -a "v$VERSION" -m "v$VERSION"
git push origin main
git push origin "v$VERSION"
```

The tag uses a `v`-prefix (`v0.3.1`, not `0.3.1`) to match the convention most release-automation tools expect.

### 6. Create the GitHub Release

Easiest path is the `gh` CLI:

```bash
gh release create "v$VERSION" \
  --title "v$VERSION" \
  --notes-file <(awk "/^## \\[$VERSION\\]/,/^## \\[/" CHANGELOG.md | sed '$d') \
  /tmp/backblaze-labs-b2-sdk-${VERSION}.tgz
```

What that does:

- Creates the release at the tag.
- Pulls the matching `CHANGELOG.md` section into the release body.
- Attaches the npm tarball as a downloadable artifact for users who don't want to install from npm.

Alternative: open `https://github.com/backblaze-labs/b2-sdk-typescript/releases/new`, pick the tag, click *Generate release notes* (uses commit history), and upload the tarball manually.

### 7. Smoke test the published package

In a scratch directory:

```bash
mkdir /tmp/b2-smoke && cd /tmp/b2-smoke
pnpm init -y
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

If `VERSION` matches the just-published number and the `B2Simulator` round-trip succeeds, you're done.

---

## Releasing — the automated flow (recommended once stable)

For ongoing releases, drive everything from GitHub Actions so the release is reproducible, signed, and gated on full CI.

The workflow is already wired up at [`.github/workflows/release.yml`](.github/workflows/release.yml). It is the canonical source of truth for what runs at release time; the yaml below is reproduced for reference only — if the live file diverges, edit the live file, not this doc.

### Setup (one time)

The workflow publishes via **OIDC trusted publishing** — there is no `NPM_TOKEN` secret to create or rotate. Setup is two clicks, done once, after 0.1.0 exists on npm:

1. Configure the trusted publisher on npmjs.com (see [step 3 of First-time setup](#3-configure-trusted-publishing-after-010-is-live) for the exact field values: org `backblaze-labs`, repo `b2-sdk-typescript`, workflow `release.yml`).
2. Confirm the repo Settings → Actions → General → "Workflow permissions" allows **read and write** so `changesets/action` can open the version PR.

How OIDC publishing works: when the workflow runs `pnpm publish`, pnpm sees it's inside GitHub Actions with the `id-token: write` permission, requests a GitHub OIDC token, and exchanges it with npm for a short-lived, single-use credential scoped to this exact workflow. The credential can't be exfiltrated (it never exists as a stored secret) and can't be replayed (it expires in minutes). Provenance is attested automatically — no `--provenance` flag needed.

The live workflow is at [`.github/workflows/release.yml`](.github/workflows/release.yml) and is the canonical source of truth. Its shape (trimmed):

```yaml
permissions:
  contents: write       # changesets/action commits the version PR + tag
  id-token: write       # OIDC token for trusted publishing + provenance
  pull-requests: write  # changesets opens the "Version Packages" PR

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # changesets needs full history
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm, registry-url: 'https://registry.npmjs.org' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - uses: changesets/action@v1
        with:
          publish: pnpm publish        # publishConfig handles access + provenance; OIDC handles auth
          version: pnpm changeset version
          commit: 'release: version packages'
          title: 'release: version packages'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}   # no NPM_TOKEN
```

### Day-to-day flow with automation

1. Land PRs to `main`. Each PR includes a `.changeset/*.md` file.
2. The Release workflow opens a `release: version packages` PR that bumps the version and updates `CHANGELOG.md`.
3. When ready to release, merge that PR. The workflow then:
   - Tags the commit `v<version>`.
   - Runs `pnpm publish`, authenticating to npm via the OIDC token (no stored secret).
   - Creates a GitHub Release at the tag with the changelog section as the body.

The provenance attestation links the npm tarball back to this exact workflow run; users (and security scanners) can verify via `npm audit signatures`.

---

## Pre-releases (alpha, beta, rc)

Use changesets pre-release mode for opt-in early access:

```bash
pnpm changeset pre enter next      # or `alpha`, `beta`, `rc`
pnpm changeset                     # record changes as usual
pnpm changeset version             # bumps to e.g. 0.3.0-next.0
pnpm publish --access public --tag next --provenance
```

Users opt in with `pnpm add @backblaze-labs/b2-sdk@next`. The `latest` dist-tag is untouched.

Exit pre-release mode when shipping the stable cut:

```bash
pnpm changeset pre exit
pnpm changeset version             # bumps to 0.3.0
pnpm publish --access public --provenance
```

---

## After-the-fact corrections

Mistakes happen. Here's what's safe and what isn't.

| Situation | Action |
|---|---|
| Bad version on npm (broken types, broken build) | Publish a patch on top. **Do not** unpublish — npm forbids it after 72 hours and even within the window it breaks downstream lockfiles. |
| Truly compromised version (e.g. secret leaked) | `npm deprecate '@backblaze-labs/b2-sdk@<version>' '<reason>'`, then publish a fixed patch. Coordinate with security if a key leaked. |
| Tag points at wrong commit | Delete the local + remote tag, retag the right commit, force-push the tag: `git push --force origin v<version>`. Update the GitHub Release manually. |
| GitHub Release body is wrong | Edit it on the GitHub UI; no need to touch npm. |

---

## Checklist (TL;DR)

Cut & paste before releasing:

- [ ] All queued PRs have changesets in `.changeset/`
- [ ] `pnpm install --frozen-lockfile` clean
- [ ] `pnpm lint && pnpm lint:docs && pnpm typecheck` green
- [ ] `pnpm test && pnpm test:coverage && pnpm test:browser` green
- [ ] `pnpm run docs && pnpm build` green
- [ ] `npx attw --pack .` clean (optional but recommended)
- [ ] `pnpm changeset version` produces sensible `CHANGELOG.md`
- [ ] Tarball contents inspected: `pnpm pack && tar -tzf *.tgz | sort`
- [ ] `pnpm publish --access public --provenance` succeeds; `npm view` confirms version
- [ ] Tag `v<version>` pushed
- [ ] GitHub Release created with changelog section + tarball artifact
- [ ] Smoke test from a fresh `pnpm add @backblaze-labs/b2-sdk` passes
