import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { link, lstat, mkdir, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Options for saving an S3 response body under a configured local root. */
export interface SaveS3BodyToPathOptions {
  /** Body stream returned by `fetch`. */
  readonly body: ReadableStream<Uint8Array>
  /** Existing or creatable local root that confines all saved files. */
  readonly downloadRoot: string
  /** Relative destination path beneath `downloadRoot`. */
  readonly relativePath: string
  /** Abort signal composed by the S3 request layer. */
  readonly signal: AbortSignal
  /** Idle timeout in milliseconds; `0` disables the watchdog. */
  readonly idleTimeoutMs: number
}

/**
 * Saves an S3 response body to a safe relative path below a configured root.
 *
 * @param options - Body, root, relative path, signal, and timeout controls.
 *
 * @returns The absolute path that received the completed body.
 */
export async function saveS3BodyToPath(options: SaveS3BodyToPathOptions): Promise<string> {
  const root = await prepareDownloadRoot(options.downloadRoot)
  const relativePath = normalizeSafeRelativePath(options.relativePath)
  const finalPath = await prepareFinalPath(root, relativePath)
  const tempPath = join(
    dirname(finalPath),
    `.${basename(finalPath)}.${process.pid}.${randomUUID()}.tmp`,
  )

  const readable = Readable.fromWeb(options.body as Parameters<typeof Readable.fromWeb>[0])
  const watchdog = new IdleTimeoutTransform({
    idleTimeoutMs: options.idleTimeoutMs,
    signal: options.signal,
  })

  try {
    await pipeline(readable, watchdog, createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }))
    await publishCompletedDownload(tempPath, finalPath)
    return finalPath
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

async function prepareDownloadRoot(downloadRoot: string): Promise<string> {
  if (downloadRoot === '') {
    throw new TypeError('downloadRoot must be a non-empty local directory path.')
  }
  const resolvedRoot = resolve(downloadRoot)
  await mkdir(resolvedRoot, { recursive: true })
  const root = await realpath(resolvedRoot)
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError('downloadRoot must resolve to a real directory.')
  }
  return root
}

function normalizeSafeRelativePath(path: string): string {
  if (path === '') {
    throw new TypeError('saveToPath must be a non-empty relative path below downloadRoot.')
  }
  if (path.includes('\0')) {
    throw new TypeError('saveToPath must not contain NUL bytes.')
  }
  if (isAbsolute(path) || win32.isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    throw new TypeError('saveToPath must be relative to downloadRoot, not absolute.')
  }

  const components = path.split(/[\\/]+/)
  if (components.some((component) => component === '' || component === '.' || component === '..')) {
    throw new TypeError('saveToPath must not contain empty, ".", or ".." path components.')
  }

  return components.join(sep)
}

async function prepareFinalPath(root: string, relativePath: string): Promise<string> {
  const finalPath = join(root, relativePath)
  if (!isWithinRoot(root, finalPath)) {
    throw new TypeError('saveToPath must stay within downloadRoot.')
  }

  const components = relativePath.split(sep)
  let current = root
  for (const component of components.slice(0, -1)) {
    current = join(current, component)
    await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    const stat = await lstat(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TypeError('saveToPath parent directories must be real directories.')
    }
    const realParent = await realpath(current)
    if (!isWithinRoot(root, realParent)) {
      throw new TypeError('saveToPath parent directories must stay within downloadRoot.')
    }
  }

  await lstat(finalPath)
    .then(() => {
      throw new TypeError('saveToPath destination already exists; refusing to overwrite it.')
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })

  return finalPath
}

async function publishCompletedDownload(tempPath: string, finalPath: string): Promise<void> {
  await link(tempPath, finalPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') {
      throw new TypeError('saveToPath destination already exists; refusing to overwrite it.')
    }
    throw error
  })
  await unlink(tempPath)
}

function isWithinRoot(root: string, path: string): boolean {
  const pathRelativeToRoot = relative(root, path)
  return (
    pathRelativeToRoot === '' ||
    (!pathRelativeToRoot.startsWith('..') && !isAbsolute(pathRelativeToRoot))
  )
}

class IdleTimeoutTransform extends Transform {
  private readonly idleTimeoutMs: number
  private readonly signal: AbortSignal
  private timeout: ReturnType<typeof setTimeout> | undefined
  private readonly abortListener: () => void

  constructor(options: { readonly idleTimeoutMs: number; readonly signal: AbortSignal }) {
    super()
    this.idleTimeoutMs = options.idleTimeoutMs
    this.signal = options.signal
    this.abortListener = () => {
      this.destroy(abortReasonAsError(this.signal.reason))
    }
    if (this.signal.aborted) {
      this.destroy(abortReasonAsError(this.signal.reason))
      return
    }
    this.signal.addEventListener('abort', this.abortListener, { once: true })
    this.resetTimer()
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.resetTimer()
    callback(null, chunk)
  }

  override _flush(callback: (error?: Error | null) => void): void {
    this.clearTimer()
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.clearTimer()
    this.signal.removeEventListener('abort', this.abortListener)
    callback(error)
  }

  private resetTimer(): void {
    this.clearTimer()
    if (this.idleTimeoutMs === 0) return
    this.timeout = setTimeout(() => {
      this.destroy(new Error(`S3 GetObject saveToPath stalled for ${this.idleTimeoutMs} ms.`))
    }, this.idleTimeoutMs)
  }

  private clearTimer(): void {
    if (this.timeout !== undefined) {
      clearTimeout(this.timeout)
      this.timeout = undefined
    }
  }
}

function abortReasonAsError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('S3 GetObject saveToPath was aborted.')
}
