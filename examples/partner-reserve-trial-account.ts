/**
 * Reserve one B2 trial account through the Partner API.
 *
 * Usage:
 *   B2_CONFIRM_RESERVE_TRIAL=1 B2_MASTER_KEY_ID=xxx B2_MASTER_KEY=yyy npx tsx examples/partner-reserve-trial-account.ts <email> <term-days> <storage-tb> [region]
 */

import {
  fail,
  parseRegion,
  partnerClientFromEnv,
  positiveInteger,
  requireConfirmation,
} from './_partner/env.ts'

async function main() {
  const email = process.argv[2]
  const rawTerm = process.argv[3]
  const rawStorage = process.argv[4]

  if (email === undefined || rawTerm === undefined || rawStorage === undefined) {
    fail(
      'Usage: B2_CONFIRM_RESERVE_TRIAL=1 npx tsx examples/partner-reserve-trial-account.ts <email> <term-days> <storage-tb> [region]',
    )
  }
  const term = positiveInteger(rawTerm, 'term-days')
  const storage = positiveInteger(rawStorage, 'storage-tb')
  const region = parseRegion(process.argv[5])
  requireConfirmation('B2_CONFIRM_RESERVE_TRIAL', 'Reserving a trial creates a new account.')

  const partner = partnerClientFromEnv()
  await partner.authorize()

  const [trial] = await partner.reserveTrialAccounts({
    email,
    term,
    storage,
    ...(region !== undefined ? { region } : {}),
  })

  if (trial === undefined) {
    fail('The Partner API returned no trial account result.')
  }

  console.log(`Reserved trial account: ${trial.accountId}`)
  console.log(`Email: ${trial.email}`)
  console.log(`Bucket: ${trial.bucketName} (${trial.bucketId})`)
  console.log(`Trial dates: ${trial.startDate} to ${trial.endDate}`)
  console.log(`Application key ID: ${trial.applicationKeyId}`)
  console.log(`Application key secret: ${trial.applicationKey}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
