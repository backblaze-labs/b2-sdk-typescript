import { type FileHandle, open } from 'node:fs/promises'
import { resolve } from 'node:path'

const APPLICATION_KEY_FILE_ENV = 'B2_APPLICATION_KEY_FILE'

export interface ApplicationKeySecretRecord {
  readonly accountId?: string
  readonly applicationKeyId: string
  readonly applicationKey: string
  readonly email?: string
  readonly bucketId?: string
  readonly bucketName?: string
  readonly s3Endpoint?: string
}

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

export function applicationKeyFilePathFromEnv(): string {
  return resolve(requireEnv(APPLICATION_KEY_FILE_ENV))
}

export class ApplicationKeySecretsFile {
  private constructor(
    readonly filePath: string,
    private readonly handle: FileHandle,
  ) {}

  static async create(filePath: string): Promise<ApplicationKeySecretsFile> {
    const handle = await open(filePath, 'wx', 0o600)
    await handle.chmod(0o600)
    return new ApplicationKeySecretsFile(filePath, handle)
  }

  async write(records: readonly ApplicationKeySecretRecord[]): Promise<void> {
    if (records.length === 0) {
      throw new Error('At least one application key secret record is required.')
    }

    await this.handle.writeFile(
      `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), records }, null, 2)}\n`,
      'utf8',
    )
    await this.handle.chmod(0o600)
    await this.handle.sync()
  }

  async close(): Promise<void> {
    await this.handle.close()
  }
}

export async function createApplicationKeySecretsFile(
  filePath: string,
): Promise<ApplicationKeySecretsFile> {
  return ApplicationKeySecretsFile.create(filePath)
}

export async function writeApplicationKeySecretsFile(
  filePath: string,
  records: readonly ApplicationKeySecretRecord[],
): Promise<void> {
  const secretsFile = await createApplicationKeySecretsFile(filePath)
  try {
    await secretsFile.write(records)
  } finally {
    await secretsFile.close()
  }
}

export function formatTimestamp(timestampMillis: number): string {
  if (!Number.isFinite(timestampMillis)) return String(timestampMillis)
  return new Date(timestampMillis).toISOString()
}
