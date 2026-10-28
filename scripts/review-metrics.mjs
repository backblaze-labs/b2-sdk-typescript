#!/usr/bin/env node
// Review health metrics over recently merged PRs (see docs/review-process.md).
//
//   node scripts/review-metrics.mjs [days]
//     Prints, for PRs merged in the last `days` (default 30): human approvals and
//     human comments per PR, hours waiting on the first human review, automated
//     review rounds per PR, and the revert share as the guardrail. Needs
//     GITHUB_REPOSITORY and an authenticated `gh`. The weekly `review-metrics`
//     workflow writes the same table to its job summary.

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const QUERY = `query($q: String!, $endCursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $endCursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title createdAt mergedAt author { login }
      reviews(first: 100) { nodes { state submittedAt author { login __typename } } }
      comments(first: 100) { nodes { author { login __typename } } }
      reviewThreads(first: 100) { nodes { comments(first: 50) { nodes { author { login __typename } } } } }
    } }
  }
}`

/**
 * Whether a GraphQL actor is a bot or coding agent.
 *
 * @param {{ login: string, __typename?: string } | null} actor - comment or review author.
 * @returns {boolean} true for apps, `[bot]` logins, Copilot and deleted users.
 */
export function isAgent(actor) {
  return (
    !actor ||
    actor.__typename === 'Bot' ||
    /\[bot\]$/i.test(actor.login) ||
    /^copilot/i.test(actor.login)
  )
}

/**
 * Nearest-rank percentile.
 *
 * @param {number[]} values - samples.
 * @param {number} p - percentile in [0, 100].
 * @returns {number | null} the percentile, or null with no samples.
 */
export function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1] ?? null
}

/**
 * Per-PR review measurements.
 *
 * @param {object} pr - a PullRequest node from QUERY.
 * @returns {{ approvals: number, humanComments: number, waitHours: number | null,
 *   aiRounds: number, revert: boolean }} the measurements for one PR.
 */
export function measure(pr) {
  const author = pr.author?.login
  const human = (a) => !isAgent(a) && a.login !== author
  const reviews = pr.reviews.nodes
  const approvals = new Set(
    reviews.filter((r) => r.state === 'APPROVED' && human(r.author)).map((r) => r.author.login),
  ).size
  const threadComments = pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes)
  const humanComments = [...pr.comments.nodes, ...threadComments].filter((c) =>
    human(c.author),
  ).length
  const firstHuman = reviews
    .filter((r) => human(r.author) && r.submittedAt)
    .map((r) => Date.parse(r.submittedAt))
    .sort((a, b) => a - b)[0]
  const waitHours =
    firstHuman === undefined ? null : (firstHuman - Date.parse(pr.createdAt)) / 3_600_000
  const aiRounds = reviews.filter((r) => isAgent(r.author)).length
  return { approvals, humanComments, waitHours, aiRounds, revert: /^revert\b/i.test(pr.title) }
}

/**
 * Render the metrics table.
 *
 * @param {ReturnType<typeof measure>[]} rows - one entry per merged PR.
 * @param {number} days - window length, for the heading.
 * @returns {string} markdown.
 */
export function report(rows, days) {
  const stat = (values, digits = 0) => {
    const fmt = (v) => (v === null ? 'n/a' : v.toFixed(digits))
    return `${fmt(percentile(values, 50))} / ${fmt(percentile(values, 95))}`
  }
  const waits = rows.map((r) => r.waitHours).filter((w) => w !== null)
  const reverts = rows.filter((r) => r.revert).length
  const manyRounds = rows.filter((r) => r.aiRounds >= 5).length
  const share = (n) => (rows.length ? `${((100 * n) / rows.length).toFixed(1)}%` : 'n/a')
  return [
    `### Review metrics, last ${days} days (${rows.length} merged PRs)`,
    '',
    '| Metric | Median / p95 |',
    '|---|---|',
    `| Human approvals per PR | ${stat(rows.map((r) => r.approvals))} |`,
    `| Human comments per PR | ${stat(rows.map((r) => r.humanComments))} |`,
    `| Hours waiting on the first human review (${waits.length} PRs) | ${stat(waits, 1)} |`,
    `| Automated review rounds per PR | ${stat(rows.map((r) => r.aiRounds))} |`,
    '',
    `PRs with 5+ automated rounds: ${manyRounds} (${share(manyRounds)}). ` +
      `Guardrail, reverts: ${reverts} (${share(reverts)}).`,
  ].join('\n')
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) throw new Error('GITHUB_REPOSITORY is required')
  const days = Number(process.argv[2] ?? 30)
  if (!Number.isInteger(days) || days <= 0) throw new Error('days must be a positive integer')
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  const out = execFileSync(
    'gh',
    [
      'api',
      'graphql',
      '--paginate',
      '--slurp',
      '-f',
      `query=${QUERY}`,
      '-f',
      `q=repo:${repo} is:pr is:merged merged:>=${since}`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const prs = JSON.parse(out).flatMap((page) => page.data.search.nodes)
  const text = report(prs.map(measure), days)
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
