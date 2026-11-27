// Release gate: pull requests test against the b2-simulator, and real B2 runs
// only in integration.yml (weekly, or by workflow_dispatch). A release must not
// ship on simulator evidence alone, so the latest completed live run on main
// must be green and no older than MAX_AGE_DAYS. To release after a red or old
// run, dispatch `Integration (real B2)` on main and wait for it to pass.
import { spawnSync } from 'node:child_process'
import { isEntry, repository } from './release-policy-common.mjs'

const WORKFLOW = 'integration.yml'
// Weekly schedule plus a day of slack for a late or retried run.
export const MAX_AGE_DAYS = 8
// Runs that test main's code against real B2. `push` covers runs from before
// the live workflow became weekly-only.
const EVIDENCE_EVENTS = new Set(['schedule', 'workflow_dispatch', 'push'])

export async function githubJson(path, run = spawnSync) {
  const result = run('gh', ['api', path], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) throw new Error('GitHub API data is unavailable')
  return JSON.parse(result.stdout)
}

export async function checkLiveB2Run({
  repo: input,
  now = Date.now(),
  api = githubJson,
  maxAgeDays = MAX_AGE_DAYS,
}) {
  const repo = repository(input)
  let runs
  try {
    const page = await api(
      `repos/${repo}/actions/workflows/${WORKFLOW}/runs?branch=main&status=completed&per_page=50`,
    )
    if (!Array.isArray(page?.workflow_runs)) throw new Error('Expected workflow runs')
    runs = page.workflow_runs
  } catch {
    throw new Error('UNVERIFIED: live B2 workflow runs could not be read')
  }
  // A cancelled run (superseded by the concurrency group) says nothing about
  // B2; every other conclusion of the newest run counts.
  const latest = runs
    .filter(
      (run) =>
        run?.head_branch === 'main' &&
        EVIDENCE_EVENTS.has(run?.event) &&
        run?.status === 'completed' &&
        run?.conclusion !== 'cancelled' &&
        Number.isFinite(Date.parse(run?.created_at)),
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
  if (latest === undefined) {
    throw new Error(`No completed live B2 run (${WORKFLOW}) on main; dispatch one before releasing`)
  }
  const where = `${latest.html_url ?? `run ${latest.id}`} (${latest.event}, ${latest.created_at})`
  if (latest.conclusion !== 'success') {
    throw new Error(`Latest live B2 run concluded ${latest.conclusion}: ${where}`)
  }
  const ageDays = (now - Date.parse(latest.created_at)) / 86_400_000
  if (ageDays > maxAgeDays) {
    throw new Error(
      `Latest green live B2 run is older than ${maxAgeDays} days: ${where}; dispatch a new one`,
    )
  }
  return latest
}

if (isEntry(import.meta.url)) {
  try {
    const run = await checkLiveB2Run({ repo: process.argv[2] })
    console.log(`live-b2-run: ${run.html_url ?? run.id} succeeded at ${run.created_at}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
