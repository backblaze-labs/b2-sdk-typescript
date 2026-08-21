import { describe, expect, it } from 'vitest'
import {
  notificationCustomHeadersToRecord,
  recordToNotificationCustomHeaders,
} from './notifications.ts'

describe('notification custom header helpers', () => {
  it('converts between B2 wire arrays and lookup records', () => {
    const wireHeaders = [
      { name: 'X-B2-Source', value: 'sdk-test' },
      { name: 'X-B2-Rule', value: 'upload-webhook' },
    ] as const

    expect(notificationCustomHeadersToRecord(wireHeaders)).toEqual({
      'X-B2-Source': 'sdk-test',
      'X-B2-Rule': 'upload-webhook',
    })
    expect(
      recordToNotificationCustomHeaders({
        'X-B2-Source': 'sdk-test',
        'X-B2-Rule': 'upload-webhook',
      }),
    ).toEqual(wireHeaders)
  })

  it('uses a null-prototype record for unsafe header names', () => {
    const record = notificationCustomHeadersToRecord([
      { name: '__proto__', value: 'literal-proto' },
      { name: 'constructor', value: 'literal-constructor' },
    ])

    expect(Object.getPrototypeOf(record)).toBeNull()
    expect(Object.getOwnPropertyDescriptor(record, '__proto__')?.value).toBe('literal-proto')
    expect(record['constructor']).toBe('literal-constructor')
  })
})
