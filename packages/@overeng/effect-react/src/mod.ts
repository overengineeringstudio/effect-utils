/**
 * React integration for Effect.
 *
 * Provides utilities for integrating Effect runtime with React applications,
 * including layer-based app initialization, service context propagation,
 * and loading state management.
 *
 * @module
 */

export * from './cuid.ts'
export * from './hooks/mod.ts'
export * from './LoadingState.ts'
export {
  DefaultError,
  DefaultShutdown,
  type InCtx,
  makeReactAppLayer,
  ReactApp,
  type ReactAppProps,
  type RenderProps,
  ServiceContext,
  useServiceContext,
} from './makeReactAppLayer.tsx'
