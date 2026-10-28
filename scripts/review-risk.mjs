#!/usr/bin/env node
// Risk-tiered human approval gate (see docs/review-process.md).
//
//   node scripts/review-risk.mjs
//     The `review-risk` PR check. Classifies the PR's changed files with
//     .github/review-policy.json, then requires that many human approvals on the
//     current head commit. Bot and agent approvals never count, nor does the
//     author's own; an approval of an older commit does not cover new commits.
//     Needs GH_TOKEN, GITHUB_REPOSITORY and PR_NUMBER. The workflow runs this
//     file from the base branch, so a PR cannot loosen its own gate.

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TIERS = ['low', 'medium', 'high']

/**
 * Compile a path glob (`*` within a segment, `**` across segments) to a RegExp.
 *
 * @param {string} glob - repo-relative glob.
 * @returns {RegExp} anchored matcher.
 */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      re += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') {
      re += '[^/]*'
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/**
 * Classify a change by its files and author.
 *
 * @param {string[]} files - repo-relative paths changed by the PR.
 * @param {{ author: string, labels?: string[] }} pr - PR author login and labels.
 * @param {object} policy - parsed .github/review-policy.json.
 * @returns {{ tier: string, required: number, reasons: string[] }} the tier, the
 *   human approvals it needs, and why.
 */
export function classify(files, { author, labels = [] }, policy) {
  const rules = policy.rules.map((r) => ({ ...r, matchers: r.paths.map(globToRegExp) }))
  let tier = 'low'
  const reasons = new Set()
  for (const file of files) {
    const rule = rules.find((r) => r.matchers.some((m) => m.test(file)))
    const fileTier = rule?.tier ?? 'medium'
    if (TIERS.indexOf(fileTier) > TIERS.indexOf(tier)) tier = fileTier
    if (fileTier !== 'low') reasons.add(`${fileTier}: ${rule?.why ?? 'unclassified path'}`)
  }
  let required = policy.approvals[tier]
  if (!policy.trustedAuthors.includes(author)) {
    required += policy.untrustedAuthorExtraApprovals
    reasons.add(`author @${author} is not on the trusted list`)
  }
  if (labels.includes(policy.needsHumanLabel) && required < 1) {
    required = 1
    reasons.add(`labeled ${policy.needsHumanLabel}`)
  }
  return { tier, required, reasons: [...reasons] }
}

/**
 * Whether a GitHub user is a bot or coding agent, whose approval never counts.
 *
 * @param {{ login: string, type?: string }} user - review author.
 * @returns {boolean} true for apps, `[bot]` logins and Copilot.
 */
export function isAgent(user) {
  return user.type === 'Bot' || /\[bot\]$/i.test(user.login) || /^copilot/i.test(user.login)
}

/**
 * Human approvals that cover the head commit.
 *
 * @param {Array<{ user: { login: string, type?: string } | null, state: string, commit_id: string }>} reviews
 *   - PR reviews in submission order.
 * @param {{ author: string, headSha: string }} pr - PR author and head commit.
 * @returns {{ approvers: string[], blockers: string[] }} human logins whose latest
 *   review approves the head commit, and those whose latest review requests changes.
 */
export function countApprovals(reviews, { author, headSha }) {
  const latest = new Map()
  for (const r of reviews) {
    if (!r.user || isAgent(r.user) || r.user.login === author) continue
    if (r.state === 'COMMENTED' || r.state === 'PENDING') continue
    latest.set(r.user.login, r)
  }
  const approvers = []
  const blockers = []
  for (const [login, r] of latest) {
    if (r.state === 'APPROVED' && r.commit_id === headSha) approvers.push(login)
    if (r.state === 'CHANGES_REQUESTED') blockers.push(login)
  }
  return { approvers, blockers }
}

function ghJson(path) {
  const out = execFileSync('gh', ['api', '--paginate', '--slurp', path], { encoding: 'utf8' })
  return JSON.parse(out).flat()
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY
  const number = process.env.PR_NUMBER
  if (!repo || !number) throw new Error('GITHUB_REPOSITORY and PR_NUMBER are required')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const policy = JSON.parse(readFileSync(join(root, '.github/review-policy.json'), 'utf8'))

  const pr = JSON.parse(
    execFileSync('gh', ['api', `repos/${repo}/pulls/${number}`], { encoding: 'utf8' }),
  )
  const files = ghJson(`repos/${repo}/pulls/${number}/files?per_page=100`).flatMap((f) =>
    f.previous_filename ? [f.filename, f.previous_filename] : [f.filename],
  )
  const author = pr.user.login
  const labels = pr.labels.map((l) => l.name)
  const { tier, required, reasons } = classify(files, { author, labels }, policy)
  const reviews = ghJson(`repos/${repo}/pulls/${number}/reviews?per_page=100`)
  const { approvers, blockers } = countApprovals(reviews, { author, headSha: pr.head.sha })

  const ok = approvers.length >= required && blockers.length === 0
  const lines = [
    `### Review risk: ${tier}`,
    '',
    `Human approvals on \`${pr.head.sha.slice(0, 7)}\`: ${approvers.length}/${required}` +
      (approvers.length ? ` (${approvers.map((a) => `@${a}`).join(', ')})` : ''),
    ...(blockers.length
      ? [`Changes requested by: ${blockers.map((b) => `@${b}`).join(', ')}`]
      : []),
    '',
    ...reasons.map((r) => `- ${r}`),
  ]
  console.log(lines.join('\n'))
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
  if (!ok) process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
