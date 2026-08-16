/**
 * Reserve multiple B2 trial accounts through the Partner API.
 *
 * Usage:
 *   B2_CONFIRM_RESERVE_TRIAL=1 B2_TRIAL_BATCH_FILE=./trial-batch.json B2_TRIAL_EMAILS=a@example.com,b@example.com B2_MASTER_KEY_ID=xxx B2_MASTER_KEY=yyy npx tsx examples/partner-reserve-trial-accounts.ts
 */

import { chmod, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  ReserveTrialCreateAccountRequest,
  ReserveTrialCreateAccountRequestEntry,
  ReserveTrialCreateAccountResult,
} from '@backblaze-labs/b2-sdk/partner'
import {
  fail,
  optionalEnv,
  optionalPositiveInteger,
  requireConfirmation,
  requireEnv,
} from './_shared/env.ts'
import { parseRegion, partnerClientFromEnv } from './_shared/partner.ts'

interface PendingTrialBatchFile {
  readonly version: 1
  readonly status: 'pending'
  readonly createdAt: string
  readonly requested: ReserveTrialCreateAccountRequest
}

interface CompletedTrialBatchFile {
  readonly version: 1
  readonly status: 'completed'
  readonly createdAt: string
  readonly completedAt: string
  readonly requested: ReserveTrialCreateAccountRequest
  readonly results: readonly ReserveTrialCreateAccountResult[]
}

type TrialBatchFile = PendingTrialBatchFile | CompletedTrialBatchFile

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function trialRequestsFromEnv(): ReserveTrialCreateAccountRequest {
  const emails = requireEnv('B2_TRIAL_EMAILS')
    .split(',')
    .map((email) => email.trim())
    .filter((email) => email !== '')
  const term = optionalPositiveInteger(optionalEnv('B2_TRIAL_TERM_DAYS'), 'B2_TRIAL_TERM_DAYS', 7)
  const storage = optionalPositiveInteger(
    optionalEnv('B2_TRIAL_STORAGE_TB'),
    'B2_TRIAL_STORAGE_TB',
    1,
  )
  const region = parseRegion(optionalEnv('B2_TRIAL_REGION'))
  const entries = emails.map(
    (email): ReserveTrialCreateAccountRequestEntry => ({
      email,
      term,
      storage,
      ...(region !== undefined ? { region } : {}),
    }),
  )
  const first = entries[0]
  if (first === undefined) {
    fail('B2_TRIAL_EMAILS must include at least one email address.')
  }
  return [first, ...entries.slice(1)]
}

function batchFilePathFromEnv(): string {
  return resolve(requireEnv('B2_TRIAL_BATCH_FILE'))
}

async function existingBatchFile(batchFilePath: string): Promise<TrialBatchFile | null> {
  try {
    return JSON.parse(await readFile(batchFilePath, 'utf8')) as TrialBatchFile
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null
    fail(`Refusing to overwrite unreadable batch file: ${batchFilePath}`)
  }
}

async function refuseExistingBatch(batchFilePath: string): Promise<void> {
  const existing = await existingBatchFile(batchFilePath)
  if (existing === null) return

  if (existing.status === 'pending') {
    if (process.env.B2_RECONCILE_TRIAL_BATCH === '1') {
      console.error(`Pending batch file: ${batchFilePath}`)
      for (const request of existing.requested) {
        console.error(`  reconcile ${request.email}`)
      }
    }
    fail(
      `Batch file ${batchFilePath} is pending. Reconcile those email addresses before archiving or removing the file and choosing a new batch file.`,
    )
  }

  if (existing.status === 'completed') {
    fail(`Batch file ${batchFilePath} already contains completed results. Choose a new file.`)
  }

  fail(`Batch file ${batchFilePath} has an unknown status. Refusing to continue.`)
}

async function writePendingBatch(
  batchFilePath: string,
  requested: ReserveTrialCreateAccountRequest,
): Promise<PendingTrialBatchFile> {
  const pending: PendingTrialBatchFile = {
    version: 1,
    status: 'pending',
    createdAt: new Date().toISOString(),
    requested,
  }
  await writeFile(batchFilePath, `${JSON.stringify(pending, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  })
  await chmod(batchFilePath, 0o600)
  return pending
}

async function writeCompletedBatch(
  batchFilePath: string,
  pending: PendingTrialBatchFile,
  results: readonly ReserveTrialCreateAccountResult[],
): Promise<void> {
  const completed: CompletedTrialBatchFile = {
    ...pending,
    status: 'completed',
    completedAt: new Date().toISOString(),
    results,
  }
  await writeFile(batchFilePath, `${JSON.stringify(completed, null, 2)}\n`, { mode: 0o600 })
  await chmod(batchFilePath, 0o600)
}

async function main() {
  requireConfirmation('B2_CONFIRM_RESERVE_TRIAL', 'Reserving trials creates new accounts.')
  const batchFilePath = batchFilePathFromEnv()
  await refuseExistingBatch(batchFilePath)
  const requests = trialRequestsFromEnv()

  const partner = partnerClientFromEnv()
  await partner.authorize()

  const pending = await writePendingBatch(batchFilePath, requests)
  const trials = await partner.reserveTrialAccounts(requests)
  await writeCompletedBatch(batchFilePath, pending, trials)

  console.log(`Stored ${trials.length} completed trial result(s) in ${batchFilePath}`)
  for (const trial of trials) {
    console.log(`${trial.email}: ${trial.accountId}`)
    console.log(`  Bucket: ${trial.bucketName} (${trial.bucketId})`)
    console.log(`  Trial dates: ${trial.startDate} to ${trial.endDate}`)
    console.log(`  Application key ID: ${trial.applicationKeyId}`)
    console.log('  Application key secret: written to the restricted batch file')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
