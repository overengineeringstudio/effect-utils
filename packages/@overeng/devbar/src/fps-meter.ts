/** Animation-frame clock and page visibility source used by the FPS observer. */
export interface FpsClock {
  readonly requestFrame: (callback: FrameRequestCallback) => number
  readonly cancelFrame: (id: number) => void
  readonly visibility: {
    readonly visibilityState: DocumentVisibilityState
    readonly addEventListener: (type: 'visibilitychange', listener: () => void) => void
    readonly removeEventListener: (type: 'visibilitychange', listener: () => void) => void
  }
}

/** A mounted meter owns exactly one animation frame and none while the page is hidden. */
export const observeFps = ({
  clock,
  onSample,
}: {
  readonly clock: FpsClock
  readonly onSample: (fps: number) => void
}): (() => void) => {
  let frame: number | undefined
  let startedAt: number | undefined
  let frames = 0
  let disposed = false

  const tick: FrameRequestCallback = (now) => {
    frame = undefined
    if (disposed || clock.visibility.visibilityState !== 'visible') return
    if (startedAt === undefined) startedAt = now
    frames += 1
    const elapsed = now - startedAt
    if (elapsed >= 500) {
      onSample(Math.round((frames * 1000) / elapsed))
      startedAt = now
      frames = 0
    }
    frame = clock.requestFrame(tick)
  }

  const onVisibility = () => {
    if (clock.visibility.visibilityState !== 'visible') {
      if (frame !== undefined) clock.cancelFrame(frame)
      frame = undefined
      startedAt = undefined
      frames = 0
    } else if (!disposed && frame === undefined) {
      frame = clock.requestFrame(tick)
    }
  }

  clock.visibility.addEventListener('visibilitychange', onVisibility)
  onVisibility()
  return () => {
    disposed = true
    clock.visibility.removeEventListener('visibilitychange', onVisibility)
    if (frame !== undefined) clock.cancelFrame(frame)
    frame = undefined
  }
}
