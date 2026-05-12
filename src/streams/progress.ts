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

/** Accumulates byte and part counts and emits {@link ProgressEvent}s to a listener. */
export class ProgressTracker {
  /** Running total of bytes transferred. */
  private bytesTransferred = 0
  /** Running count of completed parts. */
  private partsCompleted = 0
  /** Timestamp when tracking began. */
  private readonly startTime: number

  /**
   * Creates a new ProgressTracker.
   * @param listener - Callback to receive progress events, or undefined to disable.
   * @param totalBytes - Expected total bytes, or null if unknown.
   * @param totalParts - Expected total parts, or null if not a multipart transfer.
   */
  constructor(
    private readonly listener: ProgressListener | undefined,
    private readonly totalBytes: number | null,
    private readonly totalParts: number | null,
  ) {
    this.startTime = Date.now()
  }

  /** Record that additional bytes have been transferred and notify the listener. */
  addBytes(count: number): void {
    this.bytesTransferred += count
    this.emit()
  }

  /** Record that a multipart part has completed and notify the listener. */
  completePart(): void {
    this.partsCompleted++
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
