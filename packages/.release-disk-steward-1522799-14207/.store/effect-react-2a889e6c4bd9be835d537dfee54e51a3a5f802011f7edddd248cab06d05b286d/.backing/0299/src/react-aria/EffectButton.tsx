import { Effect, type Scope } from 'effect'
import React from 'react'
import type { ButtonProps } from 'react-aria-components'
import { Button } from 'react-aria-components'

import { useEffectRunner } from '../context.tsx'
import {
  formatDuration,
  type EffectButtonResult,
  type UseEffectButtonOptions,
  useEffectButton,
} from '../effect-button.tsx'
import { initialProgress, type Progress, ProgressReporter } from '../progress-reporter.ts'

/**
 * Props for the React Aria EffectButton.
 */
export type EffectButtonProps<TEnv, TA, TE> = Omit<ButtonProps, 'onPress' | 'children'> & {
  /** The effect to run when pressed. May use ProgressReporter.set to report progress. */
  effect: Effect.Effect<TA, TE, TEnv | ProgressReporter | Scope.Scope>
  /** Button label shown in idle state. */
  children: React.ReactNode
  /** Optional callback when the effect completes successfully. */
  onSuccess?: (result: TA) => void
  /** Optional callback when the effect fails. */
  onError?: (error: TE) => void
  /** Label shown while running. */
  cancelLabel?: string
  /** Optional container class name. */
  containerClassName?: string
  /** Optional class name for success badge. */
  completedBadgeClassName?: string
  /** Optional class name for error badge. */
  failedBadgeClassName?: string
  /** Render function for the running label. Receives current progress and duration. */
  renderRunningLabel?: (progress: Progress, durationMs: number) => React.ReactNode
  /** Render function for the completed badge text. Receives final progress and duration. */
  renderCompletedBadge?: (finalProgress: Progress, durationMs: number) => string
}

/**
 * React Aria variant of EffectButton.
 */
export const EffectButton = <TEnv, TA, TE>({
  effect,
  children,
  onSuccess,
  onError,
  cancelLabel = 'Cancel',
  containerClassName,
  completedBadgeClassName,
  failedBadgeClassName,
  renderRunningLabel,
  renderCompletedBadge,
  ...buttonProps
}: EffectButtonProps<TEnv, TA, TE>): React.ReactElement => {
  const runEffect = useEffectRunner<TEnv>()

  const runEffectWithProgress = React.useCallback<
    UseEffectButtonOptions<TEnv, TA, TE>['runEffect']
  >((eff) => runEffect(eff.pipe(Effect.provide(ProgressReporter.live))), [runEffect])

  const { state, isRunning, liveDurationMs, onPress }: EffectButtonResult<TA, TE> = useEffectButton(
    {
      effect,
      runEffect: runEffectWithProgress,
      onSuccess,
      onError,
    },
  )

  const runningLabel = React.useMemo(() => {
    if (isRunning === false) return undefined
    if (renderRunningLabel !== undefined) {
      return renderRunningLabel(
        state._tag === 'running' ? state.progress : initialProgress,
        liveDurationMs,
      )
    }
    return `${cancelLabel} (${formatDuration(liveDurationMs)})`
  }, [cancelLabel, isRunning, liveDurationMs, renderRunningLabel, state])

  const completedBadge = React.useMemo((): string | undefined => {
    if (state._tag !== 'completed') return undefined
    if (renderCompletedBadge !== undefined) {
      return renderCompletedBadge(state.finalProgress, state.durationMs)
    }
    return `Done ${formatDuration(state.durationMs)}`
  }, [renderCompletedBadge, state])

  return (
    <div className={containerClassName ?? 'inline-flex items-center gap-2'}>
      <Button {...buttonProps} onPress={onPress}>
        {isRunning === true ? runningLabel : children}
      </Button>
      {completedBadge !== undefined && (
        <span className={completedBadgeClassName}>{completedBadge}</span>
      )}
      {state._tag === 'failed' && (
        <span className={failedBadgeClassName}>{`Failed ${formatDuration(state.durationMs)}`}</span>
      )}
    </div>
  )
}
