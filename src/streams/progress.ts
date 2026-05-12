export interface ProgressEvent {
  readonly bytesTransferred: number
  readonly totalBytes: number | null
  readonly partsCompleted: number
  readonly totalParts: number | null
  readonly elapsedMs: number
}

export type ProgressListener = (event: ProgressEvent) => void

export class ProgressTracker {
  private bytesTransferred = 0
  private partsCompleted = 0
  private readonly startTime: number

  constructor(
    private readonly listener: ProgressListener | undefined,
    private readonly totalBytes: number | null,
    private readonly totalParts: number | null,
  ) {
    this.startTime = Date.now()
  }

  addBytes(count: number): void {
    this.bytesTransferred += count
    this.emit()
  }

  completePart(): void {
    this.partsCompleted++
    this.emit()
  }

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
