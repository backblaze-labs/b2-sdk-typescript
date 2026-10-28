import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAgent, measure, percentile, report } from './review-metrics.mjs'

const user = (login) => ({ login, __typename: 'User' })
const bot = (login) => ({ login, __typename: 'Bot' })

test('nearest-rank percentiles', () => {
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([3, 1, 2], 50), 2)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10)
  assert.equal(percentile([5], 95), 5)
})

test('agents and deleted users never count as humans', () => {
  assert.equal(isAgent(bot('github-actions')), true)
  assert.equal(isAgent(user('copilot-pull-request-reviewer')), true)
  assert.equal(isAgent(user('dependabot[bot]')), true)
  assert.equal(isAgent(null), true)
  assert.equal(isAgent(user('alice')), false)
})

test('per-PR measurements exclude the author and agents', () => {
  const pr = {
    title: 'Revert "feat: x"',
    createdAt: '2026-10-01T00:00:00Z',
    author: user('author'),
    reviews: {
      nodes: [
        { state: 'COMMENTED', submittedAt: '2026-10-01T01:00:00Z', author: bot('copilot') },
        { state: 'COMMENTED', submittedAt: '2026-10-01T02:00:00Z', author: user('author') },
        { state: 'APPROVED', submittedAt: '2026-10-01T03:00:00Z', author: user('alice') },
        { state: 'APPROVED', submittedAt: '2026-10-01T04:00:00Z', author: user('alice') },
        { state: 'APPROVED', submittedAt: '2026-10-01T05:00:00Z', author: bot('claude') },
      ],
    },
    comments: { nodes: [{ author: user('bob') }, { author: user('author') }] },
    reviewThreads: {
      nodes: [{ comments: { nodes: [{ author: bot('copilot') }, { author: user('alice') }] } }],
    },
  }
  assert.deepEqual(measure(pr), {
    approvals: 1,
    humanComments: 2,
    waitHours: 3,
    aiRounds: 2,
    revert: true,
  })
})

test('report renders medians, p95 and the revert guardrail', () => {
  const rows = [
    { approvals: 1, humanComments: 0, waitHours: 2, aiRounds: 1, revert: false },
    { approvals: 0, humanComments: 3, waitHours: null, aiRounds: 6, revert: true },
  ]
  const text = report(rows, 7)
  assert.match(text, /last 7 days \(2 merged PRs\)/)
  assert.match(text, /Hours waiting on the first human review \(1 PRs\) \| 2\.0 \/ 2\.0/)
  assert.match(text, /5\+ automated rounds: 1 \(50\.0%\)/)
  assert.match(text, /reverts: 1 \(50\.0%\)/)
})
