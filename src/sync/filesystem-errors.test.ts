import { describe, expect, it } from 'vitest'
import { localFilesystemErrorReason } from './filesystem-errors.ts'

describe('localFilesystemErrorReason', () => {
  it('prefers path-independent codes and names', () => {
    expect(
      localFilesystemErrorReason(Object.assign(new Error('ignored'), { code: 'EACCES' })),
    ).toBe('EACCES')

    const named = new Error('/tmp/secret.txt')
    named.name = 'LocalFilesystemError'
    expect(localFilesystemErrorReason(named)).toBe('LocalFilesystemError')
  })

  it('falls back when neither code nor name is safe', () => {
    const unsafe = new Error('/tmp/secret.txt')
    unsafe.name = '/tmp/Error'
    expect(localFilesystemErrorReason(unsafe)).toBe('Error')
  })

  it('strips controls and bounds cleaned filesystem codes', () => {
    const coded = Object.assign(new Error('ignored'), {
      code: `E\n${'X'.repeat(100)}`,
    })
    expect(localFilesystemErrorReason(coded)).toBe(`E${'X'.repeat(79)}`)
  })
})
