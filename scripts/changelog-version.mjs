import { spawnSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))

if (version.includes('-')) {
  console.log(`changelog-version: ${version} is a prerelease; pending fragments retained`)
} else {
  const fragments = (await readdir(join(repo, '.changes/unreleased'))).filter((name) =>
    /\.ya?ml$/.test(name),
  )
  if (fragments.length === 0) {
    console.error('changelog-version: stable releases require Changie fragments')
    process.exit(1)
  }
  const changie = join(repo, 'node_modules/changie/npm/changie.js')
  const latest = spawnSync(process.execPath, [changie, 'latest', '--skip-prereleases'], {
    cwd: repo,
    encoding: 'utf8',
  })
  if (latest.error || latest.status !== 0) process.exit(latest.status || 1)
  const currentParts = version.split('+', 1)[0].split('.').map(BigInt)
  const previousParts = latest.stdout.trim().replace(/^v/, '').split('.').map(BigInt)
  const differing = currentParts.findIndex((value, index) => value !== previousParts[index])
  if (differing === -1 || currentParts[differing] < previousParts[differing]) {
    console.error('changelog-version: npm must select a version newer than the released history')
    process.exit(1)
  }
  for (const args of [['batch', `v${version}`], ['merge']]) {
    const result = spawnSync(process.execPath, [changie, ...args], { cwd: repo, stdio: 'inherit' })
    if (result.error || result.status !== 0) process.exit(result.status || 1)
  }
}
