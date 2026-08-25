/** Snapshot of upload or download progress at a point in time. */
export interface ProgressEvent {
  /** Number of bytes transferred so far. */
  readonly bytesTransferred: number
  /** Total bytes expected, or null if unknown. */
  readonly totalBytes: number | null
  /** Number of multipart parts completed so far. */
  readonly partsCompleted: number
  /** Total number of parts expected, or null if unknown. */
  readonly totalParts: number | null
  /** Milliseconds elapsed since the operation started. */
  readonly elapsedMs: number
}

/** Callback invoked each time transfer progress changes. */
export type ProgressListener = (event: ProgressEvent) => void

/** Default minimum time between byte-progress emissions. */
export const DEFAULT_PROGRESS_EMIT_INTERVAL_MS = 100

/** Internal controls for ProgressTracker emission behavior. */
export interface ProgressTrackerOptions {
  /**
   * Minimum milliseconds between byte-only progress emissions.
   * Set to 0 to emit every change.
   */
  readonly minIntervalMs?: number
}

/**
 * Accumulates byte and part counts and emits {@link ProgressEvent}s to a listener.
 *
 * Internal building block. The SDK wires one of these inside every
 * transfer that accepts an `onProgress` option; users supply the
 * listener callback, not the tracker. Exported only so SDK source
 * modules can import it; not re-exported through any subpath.
 *
 * @internal
 */
export class ProgressTracker {
  /** Running total of bytes transferred. */
  private bytesTransferred = 0
  /** Running count of completed parts. */
  private partsCompleted = 0
  /** Timestamp when tracking began. */
  private readonly startTime: number
  /** Minimum milliseconds between byte-only emissions. */
  private readonly minIntervalMs: number
  /** Timestamp of the most recent emitted snapshot. */
  private lastEmitTime: number | null = null
  /** Timer scheduled for a coalesced byte-only emission. */
  private pendingEmitTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Creates a new ProgressTracker.
   * @param listener - Callback to receive progress events, or undefined to disable.
   * @param totalBytes - Expected total bytes, or null if unknown.
   * @param totalParts - Expected total parts, or null if not a multipart transfer.
   * @param options - Optional emission controls.
   */
  constructor(
    private readonly listener: ProgressListener | undefined,
    private readonly totalBytes: number | null,
    private readonly totalParts: number | null,
    options: ProgressTrackerOptions = {},
  ) {
    this.startTime = Date.now()
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_PROGRESS_EMIT_INTERVAL_MS)
  }

  /**
   * Record that additional bytes have been transferred and schedule listener notification.
   * @param count - The number of additional bytes that were transferred.
   */
  addBytes(count: number): void {
    this.bytesTransferred += count
    this.emitThrottled()
  }

  /** Record that a multipart part has completed and notify the listener. */
  completePart(): void {
    this.partsCompleted++
    this.emitNow()
  }

  /** Emit the current progress snapshot immediately if one is pending. */
  flush(): void {
    if (this.pendingEmitTimer !== undefined) {
      this.emitNow()
    }
  }

  private emitThrottled(): void {
    if (this.listener === undefined) return
    if (this.minIntervalMs === 0) {
      this.emitNow()
      return
    }

    const now = Date.now()
    if (this.lastEmitTime === null || now - this.lastEmitTime >= this.minIntervalMs) {
      this.emitNow(now)
      return
    }

    if (this.pendingEmitTimer !== undefined) return

    const delay = Math.max(0, this.minIntervalMs - (now - this.lastEmitTime))
    this.pendingEmitTimer = setTimeout(() => {
      this.pendingEmitTimer = undefined
      this.emitNow()
    }, delay)
    ;(this.pendingEmitTimer as { unref?: () => void }).unref?.()
  }

  private clearPendingEmit(): void {
    if (this.pendingEmitTimer === undefined) return
    clearTimeout(this.pendingEmitTimer)
    this.pendingEmitTimer = undefined
  }

  private emitNow(now = Date.now()): void {
    this.clearPendingEmit()
    this.lastEmitTime = now
    this.emit()
  }

  /** Emit the current progress snapshot to the listener, if one is registered. */
  private emit(): void {
    this.listener?.({
      bytesTransferred: this.bytesTransferred,
      totalBytes: this.totalBytes,
      partsCompleted: this.partsCompleted,
      totalParts: this.totalParts,
      elapsedMs: Date.now() - this.startTime,
    })
  }
}
