/**
 * Reserve multiple B2 trial accounts through the Partner API.
 *
 * Usage:
 *   B2_CONFIRM_RESERVE_TRIAL=1 B2_TRIAL_BATCH_FILE=./trial-batch.json B2_TRIAL_EMAILS=a@example.com,b@example.com B2_MASTER_KEY_ID=xxx B2_MASTER_KEY=yyy npx tsx examples/partner-reserve-trial-accounts.ts
 */

import { resolve } from 'node:path'
import type {
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
import { refuseExistingTrialBatch, TrialBatchWriter } from './_shared/trial-batch.ts'

function trialRequestsFromEnv(): readonly ReserveTrialCreateAccountRequestEntry[] {
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

async function main() {
  requireConfirmation('B2_CONFIRM_RESERVE_TRIAL', 'Reserving trials creates new accounts.')
  const batchFilePath = batchFilePathFromEnv()
  await refuseExistingTrialBatch(batchFilePath)
  const requests = trialRequestsFromEnv()

  const partner = await partnerClientFromEnv()
  await partner.authorize()

  const batch = await TrialBatchWriter.create(batchFilePath, requests)
  const trials: ReserveTrialCreateAccountResult[] = []
  try {
    for (const request of requests) {
      await batch.recordInProgress(request)
      const trial = await partner.reserveTrialAccount(request)
      await batch.recordResult(trial)
      trials.push(trial)
    }
    await batch.complete()
  } finally {
    await batch.close()
  }

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
