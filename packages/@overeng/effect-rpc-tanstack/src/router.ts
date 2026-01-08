/**
 * Effect-native TanStack Router integration
 *
 * @since 0.1.0
 */

import {
  createFileRoute,
  type ErrorRouteComponent,
  type FileRoutesByPath,
  type RouteComponent,
} from '@tanstack/react-router'
import { Cause, Effect, Exit, type Layer, Option } from 'effect'

/**
 * Encoded Exit for SSR serialization.
 * Uses plain object to avoid seroval serialization issues with Schema classes.
 */
export interface ExitEncoded {
  readonly _tag: 'Success' | 'Failure'
  readonly value?: unknown
  readonly error?: unknown
  readonly defect?: string
}

/**
 * Create an ExitEncoded object
 */
const makeExitEncoded = (data: ExitEncoded): ExitEncoded => data

/**
 * Convert a value to a plain object for serialization.
 * This handles Effect Schema class instances which have prototype chains
 * that seroval cannot serialize.
 */
const toPlainObject = (value: unknown): unknown => {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(toPlainObject)
  if (value instanceof Date) return value.toISOString()

  const plain: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    plain[key] = toPlainObject((value as Record<string, unknown>)[key])
  }
  return plain
}

/**
 * Encode an Exit for SSR serialization
 */
export const encodeExit = <A, E>(exit: Exit.Exit<A, E>): ExitEncoded =>
  Exit.match(exit, {
    onSuccess: (value) => makeExitEncoded({ _tag: 'Success', value: toPlainObject(value) }),
    onFailure: (cause) => {
      const failure = Cause.failureOption(cause)
      if (Option.isSome(failure)) {
        return makeExitEncoded({ _tag: 'Failure', error: failure.value })
      }
      const defect = Cause.dieOption(cause)
      if (Option.isSome(defect)) {
        return makeExitEncoded({ _tag: 'Failure', defect: String(defect.value) })
      }
      return makeExitEncoded({ _tag: 'Failure', defect: Cause.pretty(cause) })
    },
  })

/**
 * Decode an ExitEncoded back to Exit
 */
export const decodeExit = <A, E>(encoded: ExitEncoded): Exit.Exit<A, E> => {
  if (encoded._tag === 'Success') {
    return Exit.succeed(encoded.value as A)
  }
  if (encoded.error !== undefined) {
    return Exit.fail(encoded.error as E)
  }
  return Exit.die(new Error(encoded.defect ?? 'Unknown error'))
}

/**
 * Effect-native loader context
 */
export interface EffectLoaderContext<TParams = unknown> {
  params: TParams
  abortController: AbortController
}

/**
 * Options for createEffectRoute
 */
export interface EffectRouteOptions<TParams, TLoaderData, TLoaderError, TLoaderContext> {
  /**
   * Effect-native loader function.
   * Returns an Effect that produces the loader data.
   */
  loader?: (
    ctx: EffectLoaderContext<TParams>,
  ) => Effect.Effect<TLoaderData, TLoaderError, TLoaderContext>

  /**
   * Layer to provide dependencies to the loader Effect.
   */
  loaderLayer?: Layer.Layer<TLoaderContext, never, never>

  /**
   * React component to render for this route.
   */
  component?: RouteComponent

  /**
   * Component to render on error.
   */
  errorComponent?: false | null | undefined | ErrorRouteComponent

  /**
   * Component to render while loading.
   */
  pendingComponent?: RouteComponent
}

/**
 * Result type for useLoaderData when using createEffectRoute.
 * Provides the Exit and helper methods for pattern matching.
 */
export interface EffectLoaderResult<A, E> {
  /**
   * The raw Exit value from the loader
   */
  readonly exit: Exit.Exit<A, E>

  /**
   * Get the success value or throw if failed
   */
  readonly getOrThrow: () => A

  /**
   * Check if the loader succeeded
   */
  readonly isSuccess: boolean

  /**
   * Check if the loader failed
   */
  readonly isFailure: boolean

  /**
   * Get the success value if present
   */
  readonly value: Option.Option<A>

  /**
   * Get the error if present
   */
  readonly error: Option.Option<E>

  /**
   * Pattern match on the Exit
   */
  readonly match: <R>(handlers: {
    readonly onSuccess: (value: A) => R
    readonly onFailure: (error: E) => R
    readonly onDefect?: (defect: unknown) => R
  }) => R
}

/**
 * Create an EffectLoaderResult from an ExitEncoded
 */
export const makeEffectLoaderResult = <A, E>(encoded: ExitEncoded): EffectLoaderResult<A, E> => {
  const exit = decodeExit<A, E>(encoded)

  return {
    exit,
    isSuccess: Exit.isSuccess(exit),
    isFailure: Exit.isFailure(exit),
    value: Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none(),
    error: Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none(),
    getOrThrow: () => {
      if (Exit.isSuccess(exit)) {
        return exit.value
      }
      throw Cause.squash(exit.cause)
    },
    match: (handlers) =>
      Exit.match(exit, {
        onSuccess: handlers.onSuccess,
        onFailure: (cause) => {
          const failure = Cause.failureOption(cause)
          if (Option.isSome(failure)) {
            return handlers.onFailure(failure.value)
          }
          if (handlers.onDefect) {
            const defect = Cause.dieOption(cause)
            if (Option.isSome(defect)) {
              return handlers.onDefect(defect.value)
            }
          }
          return handlers.onFailure(Cause.squash(cause) as E)
        },
      }),
  }
}

/**
 * Hook to use loader data from an Effect route.
 * Wraps the raw ExitEncoded in an EffectLoaderResult.
 */
export const useEffectLoaderData = <A, E>(route: {
  useLoaderData: () => ExitEncoded
}): EffectLoaderResult<A, E> => {
  const encoded = route.useLoaderData()
  return makeEffectLoaderResult<A, E>(encoded)
}

/**
 * Creates an Effect-native file route.
 *
 * This is a wrapper around TanStack Router's `createFileRoute` that provides:
 * - Effect-native loader with typed errors
 * - Automatic Exit serialization for SSR
 * - Layer-based dependency injection
 * - Pattern matching helpers for components
 *
 * @example
 * ```typescript
 * import { createEffectRoute, useEffectLoaderData } from '@overeng/effect-rpc-tanstack/router'
 *
 * export const Route = createEffectRoute('/users/$id')({
 *   loader: ({ params }) => userClient.GetUser({ id: params.id }),
 *   component: UserDetail,
 * })
 *
 * const UserDetail = () => {
 *   const result = useEffectLoaderData(Route)
 *
 *   return result.match({
 *     onSuccess: (user) => <div>{user.name}</div>,
 *     onFailure: (error) => <div>Error: {error.message}</div>,
 *   })
 * }
 * ```
 */
export const createEffectRoute = <TFilePath extends keyof FileRoutesByPath>(path: TFilePath) => {
  return <TParams, TLoaderData, TLoaderError, TLoaderContext = never>(
    options: EffectRouteOptions<TParams, TLoaderData, TLoaderError, TLoaderContext>,
  ) => {
    const tanstackRoute = createFileRoute(path)
    const loader = options.loader

    const config = {
      ...(loader
        ? {
            loader: async (ctx: { params: unknown; abortController: AbortController }) => {
              const effect = loader({
                params: ctx.params as TParams,
                abortController: ctx.abortController,
              })

              const provided = options.loaderLayer
                ? Effect.provide(effect, options.loaderLayer)
                : (effect as Effect.Effect<TLoaderData, TLoaderError, never>)

              const exit = await Effect.runPromiseExit(provided)
              return encodeExit(exit)
            },
          }
        : {}),
      ...(options.component ? { component: options.component } : {}),
      ...(options.errorComponent ? { errorComponent: options.errorComponent } : {}),
      ...(options.pendingComponent ? { pendingComponent: options.pendingComponent } : {}),
    } satisfies Parameters<typeof tanstackRoute>[0]

    return tanstackRoute(config)
  }
}
