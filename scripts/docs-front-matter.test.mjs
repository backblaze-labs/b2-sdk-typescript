import assert from 'node:assert/strict'
import test from 'node:test'
import { validateFrontMatter } from './docs-front-matter.mjs'

const valid =
  '---\ntype: guide\ntitle: Title\ndescription: Description\nstatus: active\nowner: "@ffumero2003"\nstale_after: 2099-01-01\n---\n# Title\n'
for (const field of ['type', 'title', 'description', 'status', 'owner', 'stale_after']) {
  test(`rejects missing ${field}`, () =>
    assert.ok(
      validateFrontMatter(valid.replace(new RegExp(`^${field}:.*\\n`, 'm'), '')).errors.length,
    ))
  test(`rejects empty ${field}`, () =>
    assert.ok(
      validateFrontMatter(valid.replace(new RegExp(`^${field}:.*$`, 'm'), `${field}:`)).errors
        .length,
    ))
}
for (const [name, from, to] of [
  ['invalid type', 'type: guide', 'type: invalid'],
  ['invalid status', 'status: active', 'status: invalid'],
  ['invalid owner', '@ffumero2003', 'not-a-handle'],
  ['invalid date format', '2099-01-01', '2099/01/01'],
  ['impossible date', '2099-01-01', '2099-02-30'],
]) {
  test(`rejects ${name}`, () =>
    assert.ok(validateFrontMatter(valid.replace(from, to)).errors.length))
}
test('warns without failing for stale dates', () => {
  const result = validateFrontMatter(valid.replace('2099-01-01', '2000-01-01'))
  assert.deepEqual(result.errors, [])
  assert.ok(result.warnings.length)
})

test('current documentation has valid front matter', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (
        path.startsWith('docs/references/') ||
        path.startsWith('docs/exec-plans/completed/') ||
        /^docs\/design-docs\/000/.test(path)
      )
        continue
      if (entry.isDirectory()) await visit(path)
      else if (path.endsWith('.md')) {
        const result = validateFrontMatter(await readFile(path, 'utf8'))
        for (const warning of result.warnings) console.warn(`WARNING ${path}: ${warning}`)
        assert.deepEqual(result.errors, [], `${path}: ${result.errors.join(', ')}`)
      }
    }
  }
  await visit('docs')
})
