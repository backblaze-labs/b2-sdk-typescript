import { describe, expect, it, vi } from 'vitest'
import { emitScannerSkip, regexpInputTooLongSkip } from './scan-events.ts'
import type { SyncSkipEvent } from './types.ts'

describe('scan events', () => {
  const event: SyncSkipEvent = {
    type: 'skip',
    path: 'docs/report.txt',
    size: 0,
    message: 'skipped',
    reason: 'unsafe-name',
  }

  it('emits scanner skip diagnostics to the observer', () => {
    const onSkip = vi.fn()

    emitScannerSkip({ onSkip }, event)

    expect(onSkip).toHaveBeenCalledWith(event)
  })

  it('ignores missing or failing scanner skip observers', () => {
    expect(() => emitScannerSkip(undefined, event)).not.toThrow()
    expect(() =>
      emitScannerSkip(
        {
          onSkip() {
            throw new Error('observer failed')
          },
        },
        event,
      ),
    ).not.toThrow()
  })

  it('builds regexp input length skip events', () => {
    expect(regexpInputTooLongSkip('deep/file.txt')).toEqual({
      type: 'skip',
      path: 'deep/file.txt',
      size: 0,
      message: 'Skipped sync path "deep/file.txt": path exceeds the RegExp filter input limit',
      reason: 'path-too-long-for-regexp',
    })
  })
})
