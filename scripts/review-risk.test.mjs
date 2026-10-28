import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { classify, countApprovals, globToRegExp, isAgent } from './review-risk.mjs'

const policy = JSON.parse(readFileSync(new URL('../.github/review-policy.json', import.meta.url)))
const trusted = { author: 'goanpeca' }

test('globs match within and across path segments', () => {
  assert.equal(globToRegExp('src/auth/**').test('src/auth/realms.ts'), true)
  assert.equal(globToRegExp('src/**/*.test.ts').test('src/auth/auth.test.ts'), true)
  assert.equal(globToRegExp('src/**/*.test.ts').test('src/client.test.ts'), true)
  assert.equal(globToRegExp('scripts/verify-release*.mjs').test('scripts/verify-release.mjs'), true)
  assert.equal(globToRegExp('README.md').test('docs/README.md'), false)
  assert.equal(globToRegExp('src/auth/**').test('src/authx.ts'), false)
})

test('the change, not the author, sets the tier; a PR takes its riskiest file', () => {
  assert.equal(
    classify(['docs/README.md', '.changes/unreleased/x.yaml'], trusted, policy).tier,
    'low',
  )
  assert.equal(classify(['src/auth/auth.test.ts'], trusted, policy).tier, 'low')
  assert.equal(classify(['src/client.ts', 'README.md'], trusted, policy).tier, 'medium')
  assert.equal(classify(['src/http/transport.ts'], trusted, policy).tier, 'high')
  assert.equal(classify(['README.md', '.github/workflows/ci.yml'], trusted, policy).tier, 'high')
  assert.equal(classify(['package.json'], trusted, policy).tier, 'high')
  assert.equal(classify(['some/new/file.txt'], trusted, policy).tier, 'medium')
})

test('approvals per tier, plus one for untrusted authors or a needs-human label', () => {
  assert.equal(classify(['docs/a.md'], trusted, policy).required, 0)
  assert.equal(classify(['src/client.ts'], trusted, policy).required, 1)
  assert.equal(classify(['src/raw/index.ts'], trusted, policy).required, 2)
  assert.equal(classify(['docs/a.md'], { author: 'someone-else' }, policy).required, 1)
  assert.equal(classify(['src/raw/index.ts'], { author: 'claude[bot]' }, policy).required, 3)
  assert.equal(
    classify(['docs/a.md'], { author: 'goanpeca', labels: ['needs-human-review'] }, policy)
      .required,
    1,
  )
})

test('only authorized, non-author human approvals of the head commit count', () => {
  const head = 'bbb'
  const review = (login, state, commit_id = head, type = 'User') => ({
    user: { login, type },
    state,
    commit_id,
  })
  const { approvers, blockers } = countApprovals(
    [
      review('alice', 'APPROVED'),
      review('bob', 'APPROVED', 'aaa'),
      review('author', 'APPROVED'),
      review('claude', 'APPROVED', head, 'Bot'),
      review('copilot-pull-request-reviewer', 'APPROVED'),
      review('carol', 'APPROVED'),
      review('carol', 'COMMENTED'),
      review('dave', 'APPROVED'),
      review('dave', 'CHANGES_REQUESTED'),
      review('drive-by', 'APPROVED'),
      review('drive-by-2', 'CHANGES_REQUESTED'),
      { user: null, state: 'APPROVED', commit_id: head },
    ],
    {
      author: 'author',
      headSha: head,
      reviewers: ['Alice', 'bob', 'carol', 'dave', 'author', 'claude'],
    },
  )
  assert.deepEqual(approvers.sort(), ['alice', 'carol'])
  assert.deepEqual(blockers, ['dave'])
  assert.equal(isAgent({ login: 'github-actions[bot]' }), true)
  assert.equal(isAgent({ login: 'alice', type: 'User' }), false)
})

test('the policy lists who may approve', () => {
  assert.ok(Array.isArray(policy.authorizedReviewers) && policy.authorizedReviewers.length > 0)
})
