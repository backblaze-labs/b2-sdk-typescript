#!/usr/bin/env node
// Verify the package.json, README, RELEASE.md, CHANGELOG.md, src/version.ts,
// and generated package-metadata artifacts agree on the package name and
// version. Run by `pnpm run verify:metadata` and before publishing.
//
// The motivation is that a release touches several files (package.json, the
// CHANGELOG entry, the README install snippet, etc.) and it's easy for them to
// drift. This script reads `name` and `version` from package.json and asserts:
//
//   1. Every `npm install` / `pnpm add` / `yarn add` snippet in README.md uses
//      the same scoped package name.
//   2. The README h1 starts with the package name.
//   3. CHANGELOG.md has a `## [<version>]` heading for the current version.
//   4. RELEASE.md's tarball-name examples use `name.replace('/', '-').replace('@', '')`.
//   5. src/version.ts re-exports the version from package.json (no hardcode).
//   6. Built package metadata artifacts expose only `version`, never the full
//      package.json metadata.
//      If dist/ is absent, only source metadata is checked and the output says
//      `distArtifacts=not-built`; CI and prepublish run this after build.
//
// Exits 0 on success, prints a numbered list of mismatches on failure.

import { existsSync, promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))
const repo = process.env.B2_VERIFY_METADATA_REPO
  ? resolve(process.env.B2_VERIFY_METADATA_REPO)
  : join(here, '..')
const require = createRequire(import.meta.url)

async function read(rel) {
  return await fs.readFile(join(repo, rel), 'utf8')
}

async function readIfExists(rel) {
  try {
    return await read(rel)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function walkFiles(dir) {
  /** @type {string[]} */
  const files = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(abs)))
    } else if (entry.isFile()) {
      files.push(abs)
    }
  }
  return files
}

function repoRelative(abs) {
  return relative(repo, abs)
}

function propertyKeyText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = name.expression
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.text
    }
  }
  return null
}

function extractRelativeModuleSpecifiers(file, contents) {
  /** @type {string[]} */
  const specifiers = []
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  return specifiers.filter((specifier) => specifier.startsWith('.'))
}

async function loadVersionMetadataArtifact(abs) {
  const mod =
    extname(abs) === '.cjs'
      ? require(abs)
      : await import(`${pathToFileURL(abs).href}?verifyMetadata=${Date.now()}`)
  return mod.default ?? mod
}

const pkg = JSON.parse(await read('package.json'))
const { name, version } = pkg
const tarballPrefix = `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}` // e.g. backblaze-labs-b2-sdk-0.1.0

/** @type {string[]} */
const errors = []

// --- README h1
const readme = await read('README.md')
if (!readme.startsWith(`# ${name}\n`)) {
  errors.push(`README.md h1 should be "# ${name}" (found: "${readme.split('\n', 1)[0]}")`)
}

// --- README install snippets
const installMatches = [
  /npm install (@?[^\s`]+)/g,
  /pnpm add (@?[^\s`]+)/g,
  /yarn add (@?[^\s`]+)/g,
]
for (const re of installMatches) {
  for (const m of readme.matchAll(re)) {
    if (m[1] !== name && m[1] !== `${name}@latest` && m[1] !== `${name}@next`) {
      errors.push(`README.md: install snippet "${m[0]}" should reference "${name}"`)
    }
  }
}

// --- README bare imports
const importMatches = readme.matchAll(/from\s+['"](@[^'"/]+\/[^'"]+)['"]/g)
for (const m of importMatches) {
  if (!m[1].startsWith(name)) {
    errors.push(`README.md: import "${m[1]}" should start with "${name}"`)
  }
}

// --- CHANGELOG has the version
const changelog = await read('CHANGELOG.md')
if (!new RegExp(`^## \\[${escapeRegExp(version)}\\]`, 'm').test(changelog)) {
  errors.push(`CHANGELOG.md missing "## [${version}]" heading for the current version`)
}

// --- RELEASE.md tarball naming
const release = await read('RELEASE.md')
const tarballRefs = release.match(/[a-z0-9-]+-\d+\.\d+\.\d+\.tgz/g) ?? []
for (const ref of tarballRefs) {
  // Allow either the literal current version or a `<version>` placeholder shape.
  if (!ref.startsWith(`${name.replace(/^@/, '').replace(/\//g, '-')}-`)) {
    errors.push(
      `RELEASE.md: tarball ref "${ref}" doesn't match expected prefix "${tarballPrefix.replace(version, '<version>')}"`,
    )
  }
}

// --- src/version.ts must NOT hardcode the version; must import package.json
const versionTs = await read('src/version.ts')
if (
  !/import pkg from ['"]\.\.\/package\.json['"]\s*with\s*\{\s*type:\s*['"]json['"]\s*\}/.test(
    versionTs,
  )
) {
  errors.push(
    "src/version.ts must import package.json with `import pkg from '../package.json' with { type: 'json' }`",
  )
}
if (!/export const VERSION:\s*string\s*=\s*pkg\.version/.test(versionTs)) {
  errors.push('src/version.ts must export `VERSION` derived from `pkg.version`')
}

// --- built dist must not ship full package metadata
const dist = join(repo, 'dist')
const packageManifestLeakKeys = new Set([
  'dependencies',
  'devDependencies',
  'packageManager',
  'peerDependencies',
  'peerDependenciesMeta',
  'publishConfig',
  'scripts',
])
let checkedPackageMetadataArtifacts = null
let checkedDistFiles = 0

if (existsSync(dist)) {
  const distFiles = (await walkFiles(dist)).filter((file) => /\.(?:cjs|js)$/.test(file)).sort()
  checkedDistFiles = distFiles.length

  /** @type {Set<string>} */
  const versionMetadataArtifacts = new Set()
  for (const versionFile of [join(dist, 'version.js'), join(dist, 'version.cjs')]) {
    const contents = await readIfExists(repoRelative(versionFile))
    if (contents === null) continue

    for (const specifier of extractRelativeModuleSpecifiers(versionFile, contents)) {
      versionMetadataArtifacts.add(resolve(dirname(versionFile), specifier))
    }
  }

  checkedPackageMetadataArtifacts = versionMetadataArtifacts.size
  if (checkedDistFiles === 0) {
    errors.push('dist/ exists but contains no built JS/CJS files to inspect')
  }
  if (checkedPackageMetadataArtifacts === 0) {
    errors.push(
      'dist/ exists but no version-only metadata artifact was found from dist/version.* imports',
    )
  }

  for (const artifact of versionMetadataArtifacts) {
    if (!artifact.startsWith(dist)) {
      errors.push(
        `${repoRelative(artifact)} is outside dist/ and cannot be a version metadata artifact`,
      )
      continue
    }
    if (!existsSync(artifact)) {
      errors.push(`${repoRelative(artifact)} is referenced by dist/version.* but does not exist`)
      continue
    }

    const exported = await loadVersionMetadataArtifact(artifact)
    if (exported === null || typeof exported !== 'object' || Array.isArray(exported)) {
      errors.push(`${repoRelative(artifact)} must export a version-only object`)
      continue
    }

    const keys = Object.keys(exported)
    if (keys.length !== 1 || keys[0] !== 'version') {
      errors.push(
        `${repoRelative(artifact)} must export only ${JSON.stringify(['version'])} (found ${JSON.stringify(keys)})`,
      )
    }
    if (exported.version !== version) {
      errors.push(
        `${repoRelative(artifact)} must export version ${JSON.stringify(version)} (found ${JSON.stringify(exported.version)})`,
      )
    }
  }

  for (const file of distFiles) {
    const contents = await fs.readFile(file, 'utf8')
    const source = ts.createSourceFile(
      file,
      contents,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    )

    function visit(node) {
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (ts.isSpreadAssignment(property)) continue

          const key = propertyKeyText(property.name)
          if (key !== null && packageManifestLeakKeys.has(key)) {
            errors.push(
              `${repoRelative(file)} includes package manifest key ${JSON.stringify(key)}; dist chunks must not carry full package metadata`,
            )
          }
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(source)
  }
}

if (errors.length > 0) {
  console.error(`verify-package-metadata: ${errors.length} problem(s) found`)
  errors.forEach((e, i) => {
    console.error(`  ${i + 1}. ${e}`)
  })
  process.exit(1)
}

console.log(
  `verify-package-metadata: OK (name=${name}, version=${version}, tarball=${tarballPrefix}.tgz, distArtifacts=${checkedPackageMetadataArtifacts ?? 'not-built'}, distFiles=${checkedDistFiles})`,
)
