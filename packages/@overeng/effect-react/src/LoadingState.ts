import { Context, type SubscriptionRef } from 'effect'

/** Loading state context for tracking app initialization progress */
export interface LoadingState<TProps> {
  readonly _: unique symbol
  readonly _TProps: TProps
}

/** Create a LoadingState context tag for a given props type */
export const LoadingState = <TProps>() =>
  Context.GenericTag<LoadingState<TProps>, SubscriptionRef.SubscriptionRef<TProps>>(
    '@overeng/effect-react/LoadingState',
  )
