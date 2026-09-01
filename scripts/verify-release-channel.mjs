#!/usr/bin/env node
// Assert that the built dist artifact advertises the expected User-Agent
// version channel. This catches dropped release-build env wiring before pack.

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const expectReleaseBuild = process.argv.includes('--published')

function fail(message) {
  console.error(`verify-release-channel: ${message}`)
  process.exit(1)
}

async function importBuiltModule(rel) {
  try {
    return await import(pathToFileURL(join(repo, rel)).href)
  } catch (error) {
    fail(`unable to import ${rel}; run pnpm build first (${error})`)
  }
}

const pkg = JSON.parse(await fs.readFile(join(repo, 'package.json'), 'utf8'))
const version = pkg.version
if (typeof version !== 'string' || version.length === 0) {
  fail('package.json version must be a non-empty string')
}

const stableReleaseBuild = expectReleaseBuild && !version.includes('-')
const expectedChannel = stableReleaseBuild ? 'published' : 'dev'
const expectedProductVersion = stableReleaseBuild ? version : 'dev'
const expectedToken = `b2-sdk-typescript/${expectedProductVersion}`

const versionModule = await importBuiltModule('dist/version.js')
const userAgentModule = await importBuiltModule('dist/http/user-agent.js')

const checks = [
  [versionModule.VERSION === version, `VERSION must be ${version}`],
  [versionModule.RELEASE_CHANNEL === expectedChannel, `RELEASE_CHANNEL must be ${expectedChannel}`],
  [
    versionModule.isPublishedRelease === stableReleaseBuild,
    `isPublishedRelease must be ${stableReleaseBuild}`,
  ],
  [
    typeof versionModule.productVersion === 'function',
    'productVersion must be exported by dist/version.js',
  ],
  [
    versionModule.productVersion?.() === expectedProductVersion,
    `productVersion() must be ${expectedProductVersion}`,
  ],
  [
    userAgentModule.getUserAgent?.().startsWith(`${expectedToken} `),
    `getUserAgent() must start with ${expectedToken}`,
  ],
]

for (const [ok, message] of checks) {
  if (!ok) fail(message)
}

console.log(`verify-release-channel: OK (${expectedChannel}, ${expectedToken}, version=${version})`)
