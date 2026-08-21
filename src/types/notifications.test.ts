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
})
