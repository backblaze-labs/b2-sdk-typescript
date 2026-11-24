import { githubList, isEntry, releaseTag, repository } from './release-policy-common.mjs'

function fixedAdvisories(approval, tag) {
  if (!approval) return new Set()
  try {
    const value = JSON.parse(approval)
    if (
      value.tag !== tag ||
      !Array.isArray(value.advisories) ||
      value.advisories.some((id) => !/^GHSA-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}$/.test(id))
    ) {
      throw new Error('invalid')
    }
    return new Set(value.advisories)
  } catch {
    throw new Error('Private security approval must name this exact release tag and advisory IDs')
  }
}

function dependencyFindings(alerts, holds, notes) {
  if (
    alerts.some(
      (alert) =>
        !alert.security_vulnerability ||
        !Object.hasOwn(alert.security_vulnerability, 'first_patched_version'),
    )
  ) {
    throw new Error('Missing dependency triage data')
  }
  const fixable = alerts.filter(
    (alert) => alert.security_vulnerability.first_patched_version !== null,
  ).length
  if (fixable) holds.push(`HOLD: ${fixable} dependency alerts have a patched version`)
  if (alerts.length > fixable)
    notes.push(
      `${alerts.length - fixable} dependency alerts have no patched version; record their triage before release`,
    )
}

function advisoryFindings(alerts, fixed, holds, notes) {
  if (alerts.some((alert) => !['draft', 'triage', 'published', 'closed'].includes(alert.state))) {
    throw new Error('Unknown advisory state')
  }
  const approved = alerts.filter(
    (alert) => alert.state === 'draft' && fixed.has(alert.ghsa_id),
  ).length
  const unresolved = alerts.filter(
    (alert) => alert.state === 'triage' || (alert.state === 'draft' && !fixed.has(alert.ghsa_id)),
  ).length
  if (unresolved) holds.push(`HOLD: ${unresolved} draft or triage advisories need resolution`)
  if (approved)
    notes.push(
      `${approved} draft advisories declared fixed for this release; publish them after tagging`,
    )
}

async function unpublishedAdvisories(repo, api) {
  const results = await Promise.all(
    ['draft', 'triage'].map(async (state) => {
      const alerts = await api(`repos/${repo}/security-advisories?state=${state}&per_page=100`)
      if (!Array.isArray(alerts) || alerts.some((alert) => alert?.state !== state)) {
        throw new Error('Expected unpublished advisory records')
      }
      return alerts
    }),
  )
  return results.flat()
}

export async function checkReleaseSecurity({
  repo: input,
  tag: inputTag,
  api = githubList,
  approval = '',
  defaultBranch = 'main',
}) {
  const repo = repository(input)
  const tag = releaseTag(inputTag)
  const fixed = fixedAdvisories(approval, tag)
  const holds = []
  const notes = []
  const sources = [
    [
      'Code scanning',
      `code-scanning/alerts?state=open&per_page=100&ref=${encodeURIComponent(`refs/heads/${defaultBranch}`)}`,
      (alerts) => {
        if (alerts.length)
          holds.push(`HOLD: ${alerts.length} code-scanning alerts are open on the default branch`)
      },
    ],
    [
      'Dependabot',
      'dependabot/alerts?state=open&per_page=100',
      (alerts) => dependencyFindings(alerts, holds, notes),
    ],
    [
      'Secret scanning',
      'secret-scanning/alerts?state=open&per_page=100',
      (alerts) => {
        if (alerts.length) holds.push(`HOLD: ${alerts.length} secret-scanning alerts are open`)
      },
    ],
    [
      'Repository advisories',
      () => unpublishedAdvisories(repo, api),
      (alerts) => advisoryFindings(alerts, fixed, holds, notes),
    ],
  ]
  for (const [label, path, inspect] of sources) {
    try {
      const alerts = typeof path === 'function' ? await path() : await api(`repos/${repo}/${path}`)
      if (
        !Array.isArray(alerts) ||
        alerts.some((alert) => alert === null || typeof alert !== 'object')
      )
        throw new Error('Expected alert records')
      inspect(alerts)
    } catch {
      // API bodies and private alert fields must never enter public workflow logs.
      holds.push(`UNVERIFIED: ${label} could not be checked; release is on hold`)
    }
  }
  return { holds, notes }
}

if (isEntry(import.meta.url)) {
  try {
    const result = await checkReleaseSecurity({
      repo: process.argv[3],
      tag: process.argv[2],
      approval: process.env.RELEASE_SECURITY_APPROVAL,
      defaultBranch: process.env.GITHUB_DEFAULT_BRANCH ?? 'main',
    })
    for (const note of result.notes) console.log(`NOTE: ${note}`)
    for (const hold of result.holds) console.error(hold)
    if (result.holds.length) process.exitCode = 1
    else console.log('release-security: triage gate passed')
  } catch {
    console.error(
      'UNVERIFIED: check the release tag and private security approval settings; release is on hold',
    )
    process.exitCode = 1
  }
}
