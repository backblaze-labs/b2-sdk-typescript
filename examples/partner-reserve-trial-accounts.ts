/**
 * Reserve multiple B2 trial accounts through the Partner API.
 *
 * Usage:
 *   B2_CONFIRM_RESERVE_TRIAL=1 B2_TRIAL_EMAILS=a@example.com,b@example.com B2_MASTER_KEY_ID=xxx B2_MASTER_KEY=yyy npx tsx examples/partner-reserve-trial-accounts.ts
 */

import type {
  ReserveTrialCreateAccountRequest,
  ReserveTrialCreateAccountRequestEntry,
} from '@backblaze-labs/b2-sdk/partner'
import {
  fail,
  optionalEnv,
  optionalPositiveInteger,
  parseRegion,
  partnerClientFromEnv,
  requireConfirmation,
  requireEnv,
} from './_partner/env.ts'

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

async function main() {
  requireConfirmation('B2_CONFIRM_RESERVE_TRIAL', 'Reserving trials creates new accounts.')

  const partner = partnerClientFromEnv()
  await partner.authorize()

  const trials = await partner.reserveTrialAccounts(trialRequestsFromEnv())
  for (const trial of trials) {
    console.log(`${trial.email}: ${trial.accountId}`)
    console.log(`  Bucket: ${trial.bucketName} (${trial.bucketId})`)
    console.log(`  Trial dates: ${trial.startDate} to ${trial.endDate}`)
    console.log(`  Application key ID: ${trial.applicationKeyId}`)
    console.log(`  Application key secret: ${trial.applicationKey}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
