#!/usr/bin/env node
// Mirror every `dist/**/*.d.ts` to a sibling `dist/**/*.d.cts` so the
// CJS branch of the `exports` map in package.json resolves to a real file
// when consumers use TypeScript's `nodenext` / `node16` module resolution.
//
// vite-plugin-dts only emits `.d.ts`. Without this step, attw flags
// `Cannot read properties of undefined (reading 'filename')` on the CJS
// type entries, and downstream TS projects that `require()` the SDK see
// "Cannot find type declarations" errors.
//
// `.d.ts` and `.d.cts` share identical declaration syntax — the extension
// is purely a hint to TS's resolver about which module format to expect at
// the corresponding `.js`/`.cjs` runtime file — so a byte-for-byte copy is
// the correct transform. We also copy the matching `.d.ts.map` to
// `.d.cts.map` so go-to-definition keeps working for CJS consumers; the
// map's internal `file` field still points at the `.d.ts` name, which
// TypeScript tolerates and tooling treats as a best-effort reference.

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const distDir = join(here, '..', 'dist')

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(full)))
    } else {
      files.push(full)
    }
  }
  return files
}

try {
  const files = await walk(distDir)
  let mirroredDts = 0
  let mirroredMap = 0
  for (const file of files) {
    if (file.endsWith('.d.ts')) {
      await fs.copyFile(file, file.replace(/\.d\.ts$/, '.d.cts'))
      mirroredDts += 1
    } else if (file.endsWith('.d.ts.map')) {
      await fs.copyFile(file, file.replace(/\.d\.ts\.map$/, '.d.cts.map'))
      mirroredMap += 1
    }
  }
  console.log(`build-cts-types: mirrored ${mirroredDts} .d.ts → .d.cts (+${mirroredMap} maps)`)
} catch (err) {
  console.error('build-cts-types failed:', err.message)
  process.exit(1)
}
