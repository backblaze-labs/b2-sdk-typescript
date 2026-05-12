# Releasing `@backblaze/b2-sdk`

How to cut a new version of `@backblaze/b2-sdk`, publish it to npm, and produce a matching GitHub Release.

The project uses [changesets](https://github.com/changesets/changesets) for versioning + changelog generation, [pnpm](https://pnpm.io/) for the package manager, and [GitHub Actions](https://docs.github.com/en/actions) for CI. Releases are scoped (`@backblaze/`) and published as `public` packages.

> If anything in this document conflicts with what is actually configured in [`.changeset/config.json`](.changeset/config.json), [`package.json`](package.json), or [`.github/workflows/`](.github/workflows/), trust the config and fix the doc.

---

## Prerequisites

Before your first release, make sure you have:

1. **An npm account** that is a member of the `@backblaze` org with publish rights to `@backblaze/b2-sdk`.
   - Confirm with `npm whoami` and `npm access ls-collaborators @backblaze/b2-sdk` (after the first publish).
2. **Two-factor authentication enabled** on your npm account. Required for the `@backblaze` scope.
3. **An npm automation token** stored as the GitHub Actions secret `NPM_TOKEN` (only needed for the automated release flow described below).
4. **`pnpm` 11+** locally. Install via `corepack enable && corepack prepare pnpm@11.1.0 --activate`.
5. **Push access to `main`** and permission to create tags + GitHub Releases.

Optional but recommended:

- [`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io) installed globally (`npm i -g @arethetypeswrong/cli`) for a sanity check on the `exports` map.

---

## Versioning policy

`@backblaze/b2-sdk` follows [Semantic Versioning](https://semver.org/):

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

1. Which packages are affected (only `@backblaze/b2-sdk` exists today, so this is automatic).
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
pnpm pack --pack-destination /tmp # produces backblaze-b2-sdk-<version>.tgz; inspect contents
tar -tzf /tmp/backblaze-b2-sdk-*.tgz | sort
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
npm view @backblaze/b2-sdk version           # should print the new version
npm view @backblaze/b2-sdk dist-tags          # should show `latest: <version>`
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
  --notes-file <(awk "/^## $VERSION/,/^## /" CHANGELOG.md | sed '$d') \
  /tmp/backblaze-b2-sdk-${VERSION}.tgz
```

What that does:

- Creates the release at the tag.
- Pulls the matching `CHANGELOG.md` section into the release body.
- Attaches the npm tarball as a downloadable artifact for users who don't want to install from npm.

Alternative: open `https://github.com/backblaze/b2-sdk-typescript/releases/new`, pick the tag, click *Generate release notes* (uses commit history), and upload the tarball manually.

### 7. Smoke test the published package

In a scratch directory:

```bash
mkdir /tmp/b2-smoke && cd /tmp/b2-smoke
pnpm init -y
pnpm add @backblaze/b2-sdk@latest
node --input-type=module -e "
  import { B2Client, VERSION } from '@backblaze/b2-sdk'
  import { B2Simulator } from '@backblaze/b2-sdk/simulator'
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

### Setup (one time)

1. Generate an npm **automation token** (https://www.npmjs.com/settings/<your-account>/tokens) with publish rights to `@backblaze/b2-sdk`.
2. Add it as a GitHub Actions repo secret named `NPM_TOKEN`.
3. Add a release workflow (suggested file: `.github/workflows/release.yml`). The pattern below uses [`changesets/action`](https://github.com/changesets/action), which opens a maintained "Version Packages" PR with the version bump + changelog updates, and publishes when that PR is merged.

```yaml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write       # tag + release
  id-token: write       # npm provenance attestations
  pull-requests: write  # changesets opens the "Version Packages" PR

concurrency: release-${{ github.ref }}

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # changesets needs full history
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          registry-url: 'https://registry.npmjs.org'
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - uses: changesets/action@v1
        with:
          publish: pnpm publish -r --access public --provenance
          version: pnpm changeset version
          commit: 'release: version packages'
          title: 'release: version packages'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Day-to-day flow with automation

1. Land PRs to `main`. Each PR includes a `.changeset/*.md` file.
2. The Release workflow opens a `release: version packages` PR that bumps the version and updates `CHANGELOG.md`.
3. When ready to release, merge that PR. The workflow then:
   - Tags the commit `v<version>`.
   - Runs `pnpm publish --access public --provenance` with the `NPM_TOKEN` secret.
   - Creates a GitHub Release at the tag with the changelog section as the body.

Provenance attestations created by `--provenance` link the npm tarball back to this exact workflow run; users (and security scanners) can verify via `npm audit signatures`.

---

## Pre-releases (alpha, beta, rc)

Use changesets pre-release mode for opt-in early access:

```bash
pnpm changeset pre enter next      # or `alpha`, `beta`, `rc`
pnpm changeset                     # record changes as usual
pnpm changeset version             # bumps to e.g. 0.3.0-next.0
pnpm publish --access public --tag next --provenance
```

Users opt in with `pnpm add @backblaze/b2-sdk@next`. The `latest` dist-tag is untouched.

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
| Truly compromised version (e.g. secret leaked) | `npm deprecate '@backblaze/b2-sdk@<version>' '<reason>'`, then publish a fixed patch. Coordinate with security if a key leaked. |
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
- [ ] Smoke test from a fresh `pnpm add @backblaze/b2-sdk` passes
