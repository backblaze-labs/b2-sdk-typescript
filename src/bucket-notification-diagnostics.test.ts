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
 * One test per cell so each test asserts exactly the cell it names. Inputs are the
 * signing secret and a custom header value. Console output (everything the SDK writes
 * through `console`; the SDK has no debug-tracing facility of its own) is checked on four
 * paths: success, failure before authorization, a 503 API error and a 400 API refusal
 * (the SDK does no local validation here; the simulator rejects an empty rule name).
 * Exception text is checked on the three paths that throw: the success
 * path throws nothing, so it has no exception cells; a leak on that path would show up in
 * the console cells. That makes 8 console cells plus 6 exception cells.
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
      lines.push(args.map((arg) => renderValue(arg)).join(' '))
    }),
  )
  return {
    output: () => lines.join('\n'),
    restore: () => {
      for (const spy of spies) spy.mockRestore()
    },
  }
}

/**
 * Renders any value the way a console or error report could expose it, without
 * `node:util` so the file stays isomorphic. Strings stay as-is. An `Error` contributes
 * its message, stack, enumerable fields and cause chain, whatever their type. Other
 * objects are serialized with a cycle-safe replacer that also expands nested errors,
 * falling back to `String()` for anything JSON cannot represent.
 */
function renderValue(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (typeof value === 'string') return value
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return String(value)
  }
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (value instanceof Error) {
    const fields = Object.entries(value).map(
      ([key, field]) => `${key}: ${renderValue(field, seen)}`,
    )
    const parts = [value.name, value.message, value.stack ?? '', ...fields]
    if (value.cause !== undefined) parts.push(`cause: ${renderValue(value.cause, seen)}`)
    return parts.join('\n')
  }
  try {
    let root = true
    return JSON.stringify(value, (_key, field: unknown) => {
      if (root) {
        // The first call is the value itself, already recorded in `seen` above.
        root = false
        return field
      }
      if (field instanceof Error) return renderValue(field, seen)
      if (field !== null && typeof field === 'object') {
        if (seen.has(field)) return '[Circular]'
        seen.add(field)
      }
      return field
    })
  } catch {
    return String(value)
  }
}

/** Message, stack, enumerable fields and the full cause chain of whatever was thrown. */
function exceptionText(error: unknown): string {
  return renderValue(error)
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
  // Notes on the cells below:
  // - Pre-authorization: the call fails before any code that holds the rules is reached,
  //   so the exception cells there cannot see a leak from later code; only the console
  //   cells (which watch the whole call) would catch one.
  // - API error: the canned 503 does not echo the request, so these cells prove the SDK
  //   adds no secret to the error itself.
  // - API refusal (400): the empty rule name is rejected by the simulator as a server 400.
  //   setNotificationRules does no local validation, so this is a second API-error path,
  //   not a local validation path.

  // ── signing secret × console output ─────────────────────────────────────

  it('signing secret stays out of console output on the success path', async () => {
    const { bucket } = await setup()
    const consoleOutput = captureConsole()
    await bucket.setNotificationRules([sensitiveRule()])
    consoleOutput.restore()
    expect(consoleOutput.output()).not.toContain(SIGNING_SECRET)
  })

  it('signing secret stays out of console output on the pre-authorization path', async () => {
    const { client, bucket } = await setup()
    client.accountInfo.clear()
    const consoleOutput = captureConsole()
    await expect(bucket.setNotificationRules([sensitiveRule()])).rejects.toThrow()
    consoleOutput.restore()
    expect(consoleOutput.output()).not.toContain(SIGNING_SECRET)
  })

  it('signing secret stays out of console output on the 503 API error path', async () => {
    const { bucket } = await setupWithServerError()
    const consoleOutput = captureConsole()
    await expect(bucket.setNotificationRules([sensitiveRule()])).rejects.toThrow()
    consoleOutput.restore()
    expect(consoleOutput.output()).not.toContain(SIGNING_SECRET)
  })

  it('signing secret stays out of console output on the 400 API refusal path', async () => {
    const { bucket } = await setup()
    const consoleOutput = captureConsole()
    await expect(bucket.setNotificationRules([{ ...sensitiveRule(), name: '' }])).rejects.toThrow()
    consoleOutput.restore()
    expect(consoleOutput.output()).not.toContain(SIGNING_SECRET)
  })

  // ── custom header × console output ──────────────────────────────────────

  it('custom header value stays out of console output on the success path', async () => {
    const { bucket } = await setup()
    const consoleOutput = captureConsole()
    await bucket.setNotificationRules([sensitiveRule()])
    consoleOutput.restore()
    expect(consoleOutput.output()).not.toContain(HEADER_VALUE)
  })

  it('custom header value stays out of console output on the pre-authorization path', async () => {
    const { client, bucket } = await setup()
    client.accountInfo.clear()
    const consoleOutput = captureConsole()
    await expect(bucket.setNotificationRules([sensitiveRule()])).rejects.toThrow()
    consoleOutput.restore()
    expect(consoleOutput.output()).not.toContain(HEADER_VALUE)
  })

  it('custom header value stays out of console output on the 503 API error path', async () => {
    const { bucket } = await setupWithServerError()
    const consoleOutput = captureConsole()
    await expect(bucket.setNotificationRules([sensitiveRule()])).rejects.toThrow()
    consoleOutput.restore()
    expect(consoleOutput.output()).not.toContain(HEADER_VALUE)
  })

  it('custom header value stays out of console output on the 400 API refusal path', async () => {
    const { bucket } = await setup()
    const consoleOutput = captureConsole()
    await expect(bucket.setNotificationRules([{ ...sensitiveRule(), name: '' }])).rejects.toThrow()
    consoleOutput.restore()
    expect(consoleOutput.output()).not.toContain(HEADER_VALUE)
  })

  // ── signing secret × exception ───────────────────────────────────────────

  it('signing secret stays out of exception text on the pre-authorization path', async () => {
    const { client, bucket } = await setup()
    client.accountInfo.clear()
    const error = await thrownBy(bucket.setNotificationRules([sensitiveRule()]))
    expect(error).toBeInstanceOf(Error)
    expect(exceptionText(error)).not.toContain(SIGNING_SECRET)
  })

  it('signing secret stays out of exception text on the 503 API error path', async () => {
    const { bucket } = await setupWithServerError()
    const error = await thrownBy(bucket.setNotificationRules([sensitiveRule()]))
    expect(error).toBeInstanceOf(Error)
    expect(exceptionText(error)).not.toContain(SIGNING_SECRET)
  })

  it('signing secret stays out of exception text on the 400 API refusal path', async () => {
    const { bucket } = await setup()
    const error = await thrownBy(bucket.setNotificationRules([{ ...sensitiveRule(), name: '' }]))
    expect(error).toBeInstanceOf(Error)
    expect(exceptionText(error)).not.toContain(SIGNING_SECRET)
  })

  // ── custom header × exception ────────────────────────────────────────────

  it('custom header value stays out of exception text on the pre-authorization path', async () => {
    const { client, bucket } = await setup()
    client.accountInfo.clear()
    const error = await thrownBy(bucket.setNotificationRules([sensitiveRule()]))
    expect(error).toBeInstanceOf(Error)
    expect(exceptionText(error)).not.toContain(HEADER_VALUE)
  })

  it('custom header value stays out of exception text on the 503 API error path', async () => {
    const { bucket } = await setupWithServerError()
    const error = await thrownBy(bucket.setNotificationRules([sensitiveRule()]))
    expect(error).toBeInstanceOf(Error)
    expect(exceptionText(error)).not.toContain(HEADER_VALUE)
  })

  it('custom header value stays out of exception text on the 400 API refusal path', async () => {
    const { bucket } = await setup()
    const error = await thrownBy(bucket.setNotificationRules([{ ...sensitiveRule(), name: '' }]))
    expect(error).toBeInstanceOf(Error)
    expect(exceptionText(error)).not.toContain(HEADER_VALUE)
  })
})
