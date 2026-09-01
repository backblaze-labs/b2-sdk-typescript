import { mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PartnerClient } from '../src/partner/client.ts'
import { APPLICATION_KEY_REDACTED } from '../src/partner/redaction.ts'
import { B2Simulator } from '../src/simulator/index.ts'
import type {
  ReserveTrialCreateAccountRequestEntry,
  ReserveTrialCreateAccountResult,
} from '../src/types/partner.ts'
import { type ApplicationKeySecretRecord, writeApplicationKeySecretsFile } from './_shared/env.ts'
import { TrialBatchWriter } from './_shared/trial-batch.ts'

const RAW_SECRET = 'live-application-key-secret'

async function captureStdoutStderr(fn: () => Promise<void>): Promise<{
  readonly stdout: string
  readonly stderr: string
}> {
  let stdout = ''
  let stderr = ''
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: unknown,
    _encoding?: unknown,
    callback?: unknown,
  ): boolean => {
    stdout += String(chunk)
    if (typeof callback === 'function') callback()
    return true
  }) as typeof process.stdout.write)
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(((
    chunk: unknown,
    _encoding?: unknown,
    callback?: unknown,
  ): boolean => {
    stderr += String(chunk)
    if (typeof callback === 'function') callback()
    return true
  }) as typeof process.stderr.write)

  try {
    await fn()
  } finally {
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
  }

  return { stdout, stderr }
}

function secretRecord(): ApplicationKeySecretRecord {
  return {
    accountId: 'account-1',
    applicationKeyId: 'key-id-1',
    applicationKey: RAW_SECRET,
    email: 'trial@example.com',
  }
}

function trialRequest(): readonly [ReserveTrialCreateAccountRequestEntry] {
  return [{ email: 'trial@example.com', term: 7, storage: 1 }]
}

function trialResult(): ReserveTrialCreateAccountResult {
  return {
    accountId: 'account-1',
    applicationKey: RAW_SECRET,
    applicationKeyId: 'key-id-1',
    s3Endpoint: 's3.example.com',
    startDate: '2026-08-16',
    endDate: '2026-08-23',
    email: 'trial@example.com',
    bucketName: 'trial-bucket',
    bucketId: 'bucket-1',
  } as ReserveTrialCreateAccountResult
}

describe('Partner examples secret handling', () => {
  it('writes application key secrets only to a restricted file, even with print toggles set', async () => {
    const previousPrintEnv = process.env['B2_PRINT_APPLICATION_KEY']
    process.env['B2_PRINT_APPLICATION_KEY'] = '1'
    const dir = await mkdtemp(join(tmpdir(), 'b2-example-secret-'))
    const secretPath = join(dir, 'application-key.json')

    try {
      const output = await captureStdoutStderr(async () => {
        await writeApplicationKeySecretsFile(secretPath, [secretRecord()])
      })

      expect(output.stdout).not.toContain(RAW_SECRET)
      expect(output.stderr).not.toContain(RAW_SECRET)
      expect(await readFile(secretPath, 'utf8')).toContain(RAW_SECRET)
      if (process.platform !== 'win32') {
        expect((await stat(secretPath)).mode & 0o777).toBe(0o600)
      }
    } finally {
      if (previousPrintEnv === undefined) {
        delete process.env['B2_PRINT_APPLICATION_KEY']
      } else {
        process.env['B2_PRINT_APPLICATION_KEY'] = previousPrintEnv
      }
    }
  })

  it('checkpoints each trial result before continuing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b2-example-batch-'))
    const batchPath = join(dir, 'trial-batch.json')
    const request = trialRequest()
    const writer = await TrialBatchWriter.create(batchPath, request)

    try {
      await writer.recordInProgress(request[0])
      let checkpoint = JSON.parse(await readFile(batchPath, 'utf8'))
      expect(checkpoint).toMatchObject({
        status: 'pending',
        inProgressEmail: 'trial@example.com',
        results: [],
      })

      await writer.recordResult(trialResult())
      checkpoint = JSON.parse(await readFile(batchPath, 'utf8'))
      expect(checkpoint).toMatchObject({
        status: 'pending',
        results: [{ email: 'trial@example.com', applicationKey: RAW_SECRET }],
      })
      expect(checkpoint).not.toHaveProperty('inProgressEmail')
    } finally {
      await writer.close()
    }
  })

  it('checkpoints raw keys from SDK-created trial results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b2-example-sdk-batch-'))
    const batchPath = join(dir, 'trial-batch.json')
    const request = [{ email: 'sdk-trial@example.com', term: 7, storage: 1 }] satisfies readonly [
      ReserveTrialCreateAccountRequestEntry,
    ]
    const sim = new B2Simulator({ partnerAuthorize: true })
    const partner = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport: sim.transport(),
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })
    await partner.authorize()
    const writer = await TrialBatchWriter.create(batchPath, request)

    try {
      await writer.recordInProgress(request[0])
      const trial = await partner.reserveTrialAccount(request[0])
      const rawKey = trial.applicationKey

      expect(JSON.stringify(trial)).toContain(APPLICATION_KEY_REDACTED)
      expect(JSON.stringify(trial)).not.toContain(rawKey)

      await writer.recordResult(trial)
      const body = await readFile(batchPath, 'utf8')
      const checkpoint = JSON.parse(body) as unknown

      expect(body).toContain(rawKey)
      expect(body).not.toContain(APPLICATION_KEY_REDACTED)
      expect(checkpoint).toMatchObject({
        status: 'pending',
        results: [{ email: 'sdk-trial@example.com', applicationKey: rawKey }],
      })
    } finally {
      await writer.close()
    }
  })

  it.skipIf(process.platform === 'win32')(
    'refuses to write batch secrets after the batch path is swapped',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'b2-example-batch-swap-'))
      const batchPath = join(dir, 'trial-batch.json')
      const writer = await TrialBatchWriter.create(batchPath, trialRequest())

      try {
        await unlink(batchPath)
        await writeFile(batchPath, '', { mode: 0o644 })

        await expect(writer.recordResult(trialResult())).rejects.toThrow(/regular file|changed/)
        expect(await readFile(batchPath, 'utf8')).not.toContain(RAW_SECRET)
      } finally {
        await writer.close()
      }
    },
  )
})
