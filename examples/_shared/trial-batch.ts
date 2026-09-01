import type { Stats } from 'node:fs'
import { type FileHandle, lstat, open, readFile } from 'node:fs/promises'
import type {
  ReserveTrialCreateAccountRequestEntry,
  ReserveTrialCreateAccountResult,
} from '@backblaze-labs/b2-sdk/partner'

const BATCH_FILE_MODE = 0o600

export interface TrialBatchCheckpoint {
  readonly version: 1
  readonly status: 'pending' | 'completed'
  readonly createdAt: string
  readonly updatedAt: string
  readonly requested: readonly ReserveTrialCreateAccountRequestEntry[]
  readonly inProgressEmail?: string
  readonly results: readonly ReserveTrialCreateAccountResult[]
}

function requestForCheckpoint(
  request: ReserveTrialCreateAccountRequestEntry,
): ReserveTrialCreateAccountRequestEntry {
  return {
    email: request.email,
    ...(request.region !== undefined ? { region: request.region } : {}),
    term: request.term,
    storage: request.storage,
  }
}

function resultForCheckpoint(
  result: ReserveTrialCreateAccountResult,
): ReserveTrialCreateAccountResult {
  // Preserve the raw one-time key even when SDK result objects install redacting toJSON hooks.
  return {
    accountId: result.accountId,
    applicationKey: result.applicationKey,
    applicationKeyId: result.applicationKeyId,
    s3Endpoint: result.s3Endpoint,
    startDate: result.startDate,
    endDate: result.endDate,
    email: result.email,
    bucketName: result.bucketName,
    bucketId: result.bucketId,
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function fileMode(stat: Stats): number {
  return stat.mode & 0o777
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function assertOriginalBatchPath(filePath: string, pathStat: Stats, originalStat: Stats): void {
  if (!pathStat.isFile()) {
    throw new Error(`Batch file path is no longer a regular file: ${filePath}`)
  }
  if (!sameFile(pathStat, originalStat)) {
    throw new Error(`Batch file path changed before secrets could be written: ${filePath}`)
  }
  if (process.platform !== 'win32') {
    if (pathStat.uid !== originalStat.uid) {
      throw new Error(`Batch file owner changed before secrets could be written: ${filePath}`)
    }
    if (fileMode(pathStat) !== BATCH_FILE_MODE) {
      throw new Error(`Batch file permissions changed before secrets could be written: ${filePath}`)
    }
  }
}

function asTrialBatchCheckpoint(value: unknown, filePath: string): TrialBatchCheckpoint {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Batch file ${filePath} is not a JSON object.`)
  }
  const batch = value as Partial<TrialBatchCheckpoint>
  if (
    batch.version !== 1 ||
    (batch.status !== 'pending' && batch.status !== 'completed') ||
    !Array.isArray(batch.requested) ||
    !Array.isArray(batch.results)
  ) {
    throw new Error(`Batch file ${filePath} does not use the expected trial batch format.`)
  }
  return batch as TrialBatchCheckpoint
}

function remainingEmails(batch: TrialBatchCheckpoint): readonly string[] {
  const completed = new Set(batch.results.map((result) => result.email))
  return batch.requested
    .map((request) => request.email)
    .filter((email) => email === batch.inProgressEmail || !completed.has(email))
}

export async function existingTrialBatch(
  batchFilePath: string,
): Promise<TrialBatchCheckpoint | null> {
  try {
    return asTrialBatchCheckpoint(JSON.parse(await readFile(batchFilePath, 'utf8')), batchFilePath)
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null
    throw err
  }
}

export async function refuseExistingTrialBatch(batchFilePath: string): Promise<void> {
  const existing = await existingTrialBatch(batchFilePath)
  if (existing === null) return

  if (existing.status === 'pending') {
    if (process.env['B2_RECONCILE_TRIAL_BATCH'] === '1') {
      console.error(`Pending batch file: ${batchFilePath}`)
      console.error(`Completed result count: ${existing.results.length}`)
      for (const email of remainingEmails(existing)) {
        console.error(`  reconcile ${email}`)
      }
    }
    throw new Error(
      `Batch file ${batchFilePath} is pending. Reconcile the listed email addresses before archiving or removing the file and choosing a new batch file.`,
    )
  }

  throw new Error(
    `Batch file ${batchFilePath} already contains completed results. Choose a new file.`,
  )
}

export class TrialBatchWriter {
  private checkpoint: TrialBatchCheckpoint

  private constructor(
    readonly filePath: string,
    private readonly handle: FileHandle,
    private readonly originalStat: Stats,
    checkpoint: TrialBatchCheckpoint,
  ) {
    this.checkpoint = checkpoint
  }

  static async create(
    filePath: string,
    requested: readonly ReserveTrialCreateAccountRequestEntry[],
  ): Promise<TrialBatchWriter> {
    const handle = await open(filePath, 'wx+', BATCH_FILE_MODE)
    await handle.chmod(BATCH_FILE_MODE)
    const checkpoint: TrialBatchCheckpoint = {
      version: 1,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      requested: requested.map((request) => requestForCheckpoint(request)),
      results: [],
    }
    const writer = new TrialBatchWriter(filePath, handle, await handle.stat(), checkpoint)
    await writer.writeCheckpoint(checkpoint)
    return writer
  }

  async recordInProgress(request: ReserveTrialCreateAccountRequestEntry): Promise<void> {
    await this.writeCheckpoint({
      ...this.checkpoint,
      status: 'pending',
      updatedAt: new Date().toISOString(),
      inProgressEmail: request.email,
    })
  }

  async recordResult(result: ReserveTrialCreateAccountResult): Promise<void> {
    await this.writeCheckpoint({
      version: 1,
      status: 'pending',
      createdAt: this.checkpoint.createdAt,
      updatedAt: new Date().toISOString(),
      requested: this.checkpoint.requested,
      results: [...this.checkpoint.results, resultForCheckpoint(result)],
    })
  }

  async complete(): Promise<void> {
    await this.writeCheckpoint({
      version: 1,
      status: 'completed',
      createdAt: this.checkpoint.createdAt,
      updatedAt: new Date().toISOString(),
      requested: this.checkpoint.requested,
      results: this.checkpoint.results,
    })
  }

  async close(): Promise<void> {
    await this.handle.close()
  }

  private async writeCheckpoint(checkpoint: TrialBatchCheckpoint): Promise<void> {
    const pathStat = await lstat(this.filePath)
    assertOriginalBatchPath(this.filePath, pathStat, this.originalStat)
    const fdStat = await this.handle.stat()
    assertOriginalBatchPath(this.filePath, fdStat, this.originalStat)

    const body = new TextEncoder().encode(`${JSON.stringify(checkpoint, null, 2)}\n`)
    await this.handle.truncate(0)
    const { bytesWritten } = await this.handle.write(body, 0, body.byteLength, 0)
    if (bytesWritten !== body.byteLength) {
      throw new Error(`Could not write a complete trial batch checkpoint: ${this.filePath}`)
    }
    await this.handle.sync()
    this.checkpoint = checkpoint
  }
}
