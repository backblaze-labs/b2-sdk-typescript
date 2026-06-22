import { describe, expect, it } from 'vitest'
import { sanitizeErrorReason } from './error-reason.ts'

describe('sanitizeErrorReason', () => {
  it('strips control characters from error codes and messages', () => {
    const coded = Object.assign(new Error('ignored'), { code: 'bad\nrequest\x1b[31m' })
    expect(sanitizeErrorReason(coded)).toBe('badrequest[31m')

    expect(sanitizeErrorReason(new Error('line one\r\nline two\x1b[0m'))).toBe(
      'line oneline two[0m',
    )
  })

  it('redacts filesystem-looking messages and bounds output length', () => {
    expect(sanitizeErrorReason(new Error("ENOENT: open '/tmp/secret.txt'"))).toBe('Error')
    expect(sanitizeErrorReason(new Error('x'.repeat(250)))).toHaveLength(200)
    expect(sanitizeErrorReason(new Error(`   ${'x'.repeat(10_000)}`))).toHaveLength(200)
  })
})
