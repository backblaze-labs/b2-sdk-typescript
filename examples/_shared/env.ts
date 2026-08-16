const PRINT_APPLICATION_KEY_ENV = 'B2_PRINT_APPLICATION_KEY'

export function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (value !== undefined && value !== '') return value
  fail(`Set ${name} before running this example.`)
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

export function masterKeyOptions(): {
  readonly masterKeyId: string
  readonly masterKey: string
  readonly realm?: string
} {
  const realm = optionalEnv('B2_REALM')
  return {
    masterKeyId: requireEnv('B2_MASTER_KEY_ID'),
    masterKey: requireEnv('B2_MASTER_KEY'),
    ...(realm !== undefined ? { realm } : {}),
  }
}

export function positiveInteger(raw: string | undefined, name: string): number {
  if (raw === undefined || raw.trim() === '') {
    fail(`Provide ${name}.`)
  }

  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer.`)
  }
  return value
}

export function optionalPositiveInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  return positiveInteger(raw, name)
}

export function requireConfirmation(envName: string, action: string): void {
  if (process.env[envName] === '1') return
  fail(`${action} Set ${envName}=1 to confirm.`)
}

export function printApplicationKeySecret(applicationKey: string): void {
  console.log(
    `Application key secret: [redacted; set ${PRINT_APPLICATION_KEY_ENV}=1 to reveal on stderr]`,
  )

  if (process.env[PRINT_APPLICATION_KEY_ENV] !== '1') return

  console.error(
    'Application key secret (shown once, keep private; do not enable this in CI or logged shells):',
  )
  console.error(applicationKey)
}

export function formatTimestamp(timestampMillis: number): string {
  if (!Number.isFinite(timestampMillis)) return String(timestampMillis)
  return new Date(timestampMillis).toISOString()
}
