/**
 * Performance metrics tracking for benchmark suite
 */

/** Performance metrics for benchmarks */
export interface BenchMetrics {
  fps: number
  frameTimeMs: number
  eventThroughput: number
  stateUpdateTimeMs: number
  renderTimeMs: number
  memoryMB: number
}

/** Timestamped snapshot of benchmark metrics */
export interface MetricsSnapshot {
  timestamp: number
  metrics: BenchMetrics
}

const hrtime = () => {
  const [sec, nsec] = process.hrtime()
  return sec * 1000 + nsec / 1e6
}

/** Tracks performance metrics during benchmark execution */
export class MetricsTracker {
  private frameCount = 0
  private eventCount = 0
  private lastSecondTimestamp = hrtime()
  private lastFrameStart = 0
  private lastFrameEnd = 0

  private frameTimesWindow: number[] = []
  private stateUpdateTimesWindow: number[] = []
  private renderTimesWindow: number[] = []

  private readonly windowSize = 20

  private lastFps = 0
  private lastEventThroughput = 0

  startFrame(): void {
    this.lastFrameStart = hrtime()
  }

  endFrame(): void {
    this.lastFrameEnd = hrtime()
    const frameTime = this.lastFrameEnd - this.lastFrameStart
    this.frameTimesWindow.push(frameTime)
    if (this.frameTimesWindow.length > this.windowSize) {
      this.frameTimesWindow.shift()
    }
    this.frameCount++
  }

  recordEvent(): void {
    this.eventCount++
  }

  recordEvents(count: number): void {
    this.eventCount += count
  }

  recordStateUpdate(ms: number): void {
    this.stateUpdateTimesWindow.push(ms)
    if (this.stateUpdateTimesWindow.length > this.windowSize) {
      this.stateUpdateTimesWindow.shift()
    }
  }

  recordRender(ms: number): void {
    this.renderTimesWindow.push(ms)
    if (this.renderTimesWindow.length > this.windowSize) {
      this.renderTimesWindow.shift()
    }
  }

  /** Call this periodically (e.g. every 500ms) to update rate-based metrics */
  tick(): void {
    const now = hrtime()
    const elapsed = (now - this.lastSecondTimestamp) / 1000

    if (elapsed >= 0.5) {
      this.lastFps = this.frameCount / elapsed
      this.lastEventThroughput = this.eventCount / elapsed
      this.frameCount = 0
      this.eventCount = 0
      this.lastSecondTimestamp = now
    }
  }

  getMetrics(): BenchMetrics {
    const avgFrameTime = this.average(this.frameTimesWindow)
    const avgStateUpdate = this.average(this.stateUpdateTimesWindow)
    const avgRender = this.average(this.renderTimesWindow)

    return {
      fps: this.lastFps,
      frameTimeMs: avgFrameTime,
      eventThroughput: this.lastEventThroughput,
      stateUpdateTimeMs: avgStateUpdate,
      renderTimeMs: avgRender,
      memoryMB: process.memoryUsage().heapUsed / 1024 / 1024,
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      timestamp: hrtime(),
      metrics: this.getMetrics(),
    }
  }

  private average(arr: number[]): number {
    if (arr.length === 0) return 0
    return arr.reduce((a, b) => a + b, 0) / arr.length
  }
}

/** High-resolution timer utility */
export const timer = {
  now: hrtime,
  measure: <T>(fn: () => T): { result: T; ms: number } => {
    const start = hrtime()
    const result = fn()
    const ms = hrtime() - start
    return { result, ms }
  },
  measureAsync: async <T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> => {
    const start = hrtime()
    const result = await fn()
    const ms = hrtime() - start
    return { result, ms }
  },
}
