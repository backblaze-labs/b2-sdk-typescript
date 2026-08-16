import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const EXAMPLES_ROOT = join(import.meta.dirname, '..', 'examples')
const SECRET_EXAMPLES = [
  'partner-create-group-member.ts',
  'partner-reserve-trial-account.ts',
  'partner-reserve-trial-accounts.ts',
] as const

describe('Partner examples secret handling', () => {
  it.each(SECRET_EXAMPLES)('does not log raw applicationKey secrets to stdout: %s', (fileName) => {
    const source = readFileSync(join(EXAMPLES_ROOT, fileName), 'utf8')
    const unsafeStdoutLines = source
      .split(/\r?\n/)
      .filter((line) => /console\.log\(.*\.applicationKey(?!Id)\b/.test(line))

    expect(unsafeStdoutLines).toEqual([])
  })
})
