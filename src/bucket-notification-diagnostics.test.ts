import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HttpRequest, HttpResponse, HttpTransport } from './http/transport.ts'
import { B2Client, BucketType, type EventNotificationRule, EventType } from './index.ts'
import { B2Simulator } from './simulator/index.ts'
import { jsonErrorResponse, makeClient } from './test-utils/index.ts'

/**
 * Operation-level secret non-exposure for `Bucket.setNotificationRules`, the SDK's
 * replace-all notification call. A rule can carry an HMAC signing secret and custom
 * header values, which must never reach the SDK's diagnostic output or an exception.
 *
 * One test per (input, surface, path) so each test asserts exactly the cell it names:
 * inputs are the signing secret and a custom header value; surfaces are SDK diagnostic
 * output and exception text; paths are success, failure before authorization, API
 * error, and local validation error.
 *
 * The SDK has no debug-tracing facility of its own, so "SDK debug trace" here means
 * everything the SDK writes through `console` while the call runs. On the success path
 * nothing is thrown, so the exception cells assert that no exception text can carry the
 * secret (the call does not throw), which is weaker than the failure-path cells.
 */

const SIGNING_SECRET = 'hmac-signing-secret-must-not-leak-4b1e'
const HEADER_VALUE = 'custom-header-value-must-not-leak-9d7c'

function sensitiveRule(): EventNotificationRule {
  return {
    eventTypes: [EventType.ObjectCreatedAll],
    isEnabled: true,
    isSuspended: false,
    name: 'sensitive-webhook',
    objectNamePrefix: '',
    suspensionReason: '',
    targetConfiguration: {
      targetType: 'webhook',
      url: 'https://example.com/webhook',
      hmacSha256SigningSecret: SIGNING_SECRET,
      customHeaders: [{ name: 'X-Webhook-Token', value: HEADER_VALUE }],
    },
  }
}

async function setup() {
  const { client } = makeClient({ client: { retry: { maxRetries: 0 } } })
  await client.authorize()
  const bucket = await client.createBucket({
    bucketName: 'notif-diagnostics',
    bucketType: BucketType.AllPrivate,
  })
  return { client, bucket }
}

/** A client whose notification-rules endpoint answers with a server error. */
async function setupWithServerError() {
  const sim = new B2Simulator()
  const inner = sim.transport()
  const transport: HttpTransport = {
    send(request: HttpRequest): Promise<HttpResponse> {
      if (request.url.includes('b2_set_bucket_notification_rules')) {
        return Promise.resolve(jsonErrorResponse(503, 'service_unavailable', 'try again later'))
      }
      return inner.send(request)
    },
  }
  const client = new B2Client({
    applicationKeyId: 'test-key-id',
    applicationKey: 'test-key',
    transport,
    retry: { maxRetries: 0 },
  })
  await client.authorize()
  const bucket = await client.createBucket({
    bucketName: 'notif-diagnostics-server-error',
    bucketType: BucketType.AllPrivate,
  })
  return { client, bucket }
}

/** Records everything written through `console` until restored. */
function captureConsole() {
  const lines: string[] = []
  const methods = ['log', 'debug', 'info', 'warn', 'error', 'trace'] as const
  const spies = methods.map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    }),
  )
  return {
    output: () => lines.join('\n'),
    restore: () => {
      for (const spy of spies) spy.mockRestore()
    },
  }
}

/** Message, stack, enumerable fields and the cause chain of whatever was thrown. */
function exceptionText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (current instanceof Error) {
      parts.push(current.message, current.stack ?? '', JSON.stringify({ ...current }))
      current = current.cause
    } else {
      parts.push(String(current))
      current = undefined
    }
  }
  return parts.join('\n')
}

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('setNotificationRules keeps sensitive inputs out of diagnostics', () => {
  // ── signing secret × SDK debug trace ─────────────────────────────────────

  it('signing secret stays out of SDK debug trace on the success path', async () => {
    const { bucket } = await setup()
    const trace = captureConsole()
    await bucket.setNotificationRules([sensitiveRule()])
    trace.restore()
    expect(trace.output()).not.toContain(SIGNING_SECRET)
  })

  it('signing secret stays out of SDK debug trace on the pre-authorization path', async () => {
    const { client, bucket } = await setup()
    client.accountInfo.clear()
    const trace = captureConsole()
    await expect(bucket.setNotificationRules([sensitiveRule()])).rejects.toThrow()
    trace.restore()
    expect(trace.output()).not.toContain(SIGNING_SECRET)
  })

  it('signing secret stays out of SDK debug trace on the api error path', async () => {
    const { bucket } = await setupWithServerError()
    const trace = captureConsole()
    await expect(bucket.setNotificationRules([sensitiveRule()])).rejects.toThrow()
    trace.restore()
    expect(trace.output()).not.toContain(SIGNING_SECRET)
  })

  it('signing secret stays out of SDK debug trace on the validation error path', async () => {
    const { bucket } = await setup()
    const trace = captureConsole()
    await expect(bucket.setNotificationRules([{ ...sensitiveRule(), name: '' }])).rejects.toThrow()
    trace.restore()
    expect(trace.output()).not.toContain(SIGNING_SECRET)
  })

  // ── custom header × SDK debug trace ──────────────────────────────────────

  it('custom header value stays out of SDK debug trace on the success path', async () => {
    const { bucket } = await setup()
    const trace = captureConsole()
    await bucket.setNotificationRules([sensitiveRule()])
    trace.restore()
    expect(trace.output()).not.toContain(HEADER_VALUE)
  })

  it('custom header value stays out of SDK debug trace on the pre-authorization path', async () => {
    const { client, bucket } = await setup()
    client.accountInfo.clear()
    const trace = captureConsole()
    await expect(bucket.setNotificationRules([sensitiveRule()])).rejects.toThrow()
    trace.restore()
    expect(trace.output()).not.toContain(HEADER_VALUE)
  })

  it('custom header value stays out of SDK debug trace on the api error path', async () => {
    const { bucket } = await setupWithServerError()
    const trace = captureConsole()
    await expect(bucket.setNotificationRules([sensitiveRule()])).rejects.toThrow()
    trace.restore()
    expect(trace.output()).not.toContain(HEADER_VALUE)
  })

  it('custom header value stays out of SDK debug trace on the validation error path', async () => {
    const { bucket } = await setup()
    const trace = captureConsole()
    await expect(bucket.setNotificationRules([{ ...sensitiveRule(), name: '' }])).rejects.toThrow()
    trace.restore()
    expect(trace.output()).not.toContain(HEADER_VALUE)
  })

  // ── signing secret × exception ───────────────────────────────────────────

  it('signing secret stays out of exception text on the success path', async () => {
    const { bucket } = await setup()
    const error = await thrownBy(bucket.setNotificationRules([sensitiveRule()]))
    expect(error).toBeUndefined()
    expect(exceptionText(error)).not.toContain(SIGNING_SECRET)
  })

  it('signing secret stays out of exception text on the pre-authorization path', async () => {
    const { client, bucket } = await setup()
    client.accountInfo.clear()
    const error = await thrownBy(bucket.setNotificationRules([sensitiveRule()]))
    expect(error).toBeInstanceOf(Error)
    expect(exceptionText(error)).not.toContain(SIGNING_SECRET)
  })

  it('signing secret stays out of exception text on the api error path', async () => {
    const { bucket } = await setupWithServerError()
    const error = await thrownBy(bucket.setNotificationRules([sensitiveRule()]))
    expect(error).toBeInstanceOf(Error)
    expect(exceptionText(error)).not.toContain(SIGNING_SECRET)
  })

  it('signing secret stays out of exception text on the validation error path', async () => {
    const { bucket } = await setup()
    const error = await thrownBy(bucket.setNotificationRules([{ ...sensitiveRule(), name: '' }]))
    expect(error).toBeInstanceOf(Error)
    expect(exceptionText(error)).not.toContain(SIGNING_SECRET)
  })

  // ── custom header × exception ────────────────────────────────────────────

  it('custom header value stays out of exception text on the success path', async () => {
    const { bucket } = await setup()
    const error = await thrownBy(bucket.setNotificationRules([sensitiveRule()]))
    expect(error).toBeUndefined()
    expect(exceptionText(error)).not.toContain(HEADER_VALUE)
  })

  it('custom header value stays out of exception text on the pre-authorization path', async () => {
    const { client, bucket } = await setup()
    client.accountInfo.clear()
    const error = await thrownBy(bucket.setNotificationRules([sensitiveRule()]))
    expect(error).toBeInstanceOf(Error)
    expect(exceptionText(error)).not.toContain(HEADER_VALUE)
  })

  it('custom header value stays out of exception text on the api error path', async () => {
    const { bucket } = await setupWithServerError()
    const error = await thrownBy(bucket.setNotificationRules([sensitiveRule()]))
    expect(error).toBeInstanceOf(Error)
    expect(exceptionText(error)).not.toContain(HEADER_VALUE)
  })

  it('custom header value stays out of exception text on the validation error path', async () => {
    const { bucket } = await setup()
    const error = await thrownBy(bucket.setNotificationRules([{ ...sensitiveRule(), name: '' }]))
    expect(error).toBeInstanceOf(Error)
    expect(exceptionText(error)).not.toContain(HEADER_VALUE)
  })
})
