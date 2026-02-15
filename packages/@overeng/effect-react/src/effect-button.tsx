import { Effect, Exit, type Runtime, type Scope, Stream } from 'effect'
import React from 'react'

import { initialProgress, type Progress, ProgressReporter } from './progress-reporter.ts'

/**
 * UI state for a running Effect button controller.
 * @typeParam TA - Success value type
 * @typeParam TE - Error type
 */
export type EffectButtonState<TA = unknown, TE = unknown> =
  | { _tag: 'idle' }
  | {
      _tag: 'running'
      /** Timestamp when the effect started, in ms since epoch. */
      startedAt: number
      /** Cancel handle for the running effect. */
      cancel: Runtime.Cancel<unknown, unknown>
      /** Latest progress update. */
      progress: Progress
    }
  | {
      _tag: 'completed'
      /** Total duration in ms. */
      durationMs: number
      /** Final progress at completion. */
      finalProgress: Progress
      /** The successful result value. */
      result: TA
    }
  | {
      _tag: 'failed'
      /** Total duration in ms. */
      durationMs: number
      /** Error raised by the effect. */
      error: TE
    }

/**
 * Runner function used by the Effect button controller.
 */
export type EffectButtonRunEffect<TEnv> = <TA, TE>(
  effect: Effect.Effect<TA, TE, TEnv | ProgressReporter | Scope.Scope>,
) => Runtime.Cancel<TA, TE>

/**
 * Configuration for useEffectButton.
 */
export type UseEffectButtonOptions<TEnv, TA, TE> = {
  /** The effect to run when pressed. May use ProgressReporter.set to report progress. */
  effect: Effect.Effect<TA, TE, TEnv | ProgressReporter | Scope.Scope>
  /** Runner that executes the effect and returns a cancel handle (must provide ProgressReporter). */
  runEffect: EffectButtonRunEffect<TEnv>
  /** Optional callback when the effect completes successfully. */
  onSuccess?: ((result: TA) => void) | undefined
  /** Optional callback when the effect fails. */
  onError?: ((error: TE) => void) | undefined
}

/**
 * Result returned by useEffectButton.
 * @typeParam TA - Success value type
 * @typeParam TE - Error type
 */
export type EffectButtonResult<TA, TE> = {
  /** Current state for rendering. */
  state: EffectButtonState<TA, TE>
  /** Whether the effect is currently running. */
  isRunning: boolean
  /** Live duration in ms while running. */
  liveDurationMs: number
  /** Press handler that starts or cancels the effect. */
  onPress: () => void
}

/**
 * Format a duration in ms for display.
 */
export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Headless controller for running Effects with cancellation and progress tracking.
 */
export const useEffectButton = <TEnv, TA, TE>({
  effect,
  runEffect,
  onSuccess,
  onError,
}: UseEffectButtonOptions<TEnv, TA, TE>): EffectButtonResult<TA, TE> => {
  const [state, setState] = React.useState<EffectButtonState<TA, TE>>({
    _tag: 'idle',
  })
  const [liveDurationMs, setLiveDurationMs] = React.useState(0)

  React.useEffect(() => {
    if (state._tag !== 'running') return

    const interval = setInterval(() => {
      setLiveDurationMs(Date.now() - state.startedAt)
    }, 100)

    return () => clearInterval(interval)
  }, [state])

  const onPress = React.useCallback(() => {
    if (state._tag === 'running') {
      state.cancel()
      setState({ _tag: 'idle' })
      return
    }

    const startedAt = Date.now()
    setLiveDurationMs(0)

    const cancel = runEffect(
      Effect.gen(function* () {
        const progressChanges = yield* ProgressReporter.changes

        yield* progressChanges.pipe(
          Stream.tap((progress) =>
            Effect.sync(() => {
              setState((prev) => {
                if (prev._tag !== 'running') return prev
                return { ...prev, progress }
              })
            }),
          ),
          Stream.runDrain,
          Effect.forkScoped,
        )

        const exit = yield* Effect.exit(effect)

        const durationMs = Date.now() - startedAt
        if (Exit.isSuccess(exit) === true) {
          const result = exit.value
          setState((prev) => ({
            _tag: 'completed',
            durationMs,
            finalProgress: prev._tag === 'running' ? prev.progress : initialProgress,
            result,
          }))
          onSuccess?.(result)
          return
        }
        if (Exit.isInterrupted(exit) === true) {
          return
        }

        const error = exit.cause.valueOf() as TE
        setState({ _tag: 'failed', durationMs, error })
        onError?.(error)

        /** Re-raise so the effect runner can surface the error. */
        return yield* Effect.failCause(exit.cause)
      }).pipe(Effect.withSpan('ui.effect-button')),
    )

    setState({ _tag: 'running', startedAt, cancel, progress: initialProgress })
  }, [effect, onError, onSuccess, runEffect, state])

  return {
    state,
    isRunning: state._tag === 'running',
    liveDurationMs,
    onPress,
  }
}
