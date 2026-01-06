import { Context, Effect, Layer, SubscriptionRef } from 'effect'

/**
 * Generic progress state for tracking completion of multi-step operations.
 */
export interface Progress {
  /** Total number of items/steps to process. */
  total: number
  /** Number of items/steps completed so far. */
  completed: number
}

/**
 * Initial progress state for new operations.
 */
export const initialProgress: Progress = { total: 0, completed: 0 }

/**
 * Service for reporting progress during Effect execution.
 */
export class ProgressReporter extends Context.Tag('ProgressReporter')<
  ProgressReporter,
  {
    /** Set progress to a specific state. */
    readonly set: (progress: Progress) => Effect.Effect<void>
    /** Stream of progress changes. */
    readonly changes: SubscriptionRef.SubscriptionRef<Progress>['changes']
  }
>() {
  /**
   * Set progress to a specific state.
   */
  static set = (progress: Progress): Effect.Effect<void, never, ProgressReporter> =>
    ProgressReporter.pipe(Effect.flatMap((r) => r.set(progress)))

  /**
   * Access the changes stream.
   */
  static changes: Effect.Effect<
    SubscriptionRef.SubscriptionRef<Progress>['changes'],
    never,
    ProgressReporter
  > = ProgressReporter.pipe(Effect.map((r) => r.changes))

  /**
   * Layer that creates a ProgressReporter backed by a SubscriptionRef.
   */
  static live = Layer.effect(
    ProgressReporter,
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make(initialProgress)
      return {
        set: (progress: Progress) => SubscriptionRef.set(ref, progress),
        changes: ref.changes,
      }
    }),
  )
}
