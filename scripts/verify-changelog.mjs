import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const changie = join(repo, 'node_modules/changie/npm/changie.js')
const result = spawnSync(process.execPath, [changie, 'merge', '--dry-run'], {
  cwd: repo,
  encoding: 'utf8',
})
if (result.error || result.status !== 0) {
  console.error('verify-changelog: Changie could not render the released history')
  process.exit(1)
}
if (result.stdout !== (await readFile(join(repo, 'CHANGELOG.md'), 'utf8'))) {
  console.error('verify-changelog: run pnpm changelog:merge; edit fragments, not CHANGELOG.md')
  process.exit(1)
}
const pending = spawnSync(
  process.execPath,
  [changie, 'merge', '--include-unreleased', 'Pending fragments', '--dry-run'],
  { cwd: repo, encoding: 'utf8' },
)
if (pending.error || pending.status !== 0) {
  console.error('verify-changelog: pending Changie fragments could not be rendered')
  process.exit(1)
}
console.log('verify-changelog: generated history is current; pending fragments are valid')
