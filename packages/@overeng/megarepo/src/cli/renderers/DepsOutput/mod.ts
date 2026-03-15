/**
 * DepsOutput Module
 *
 * Re-exports for the deps command output.
 */

// Schema
export {
  DepsState,
  DepsAction,
  DepsSuccessState,
  DepsEmptyState,
  DepsErrorState,
  DepsMember,
  DownstreamRef,
  depsReducer,
  isDepsSuccess,
  isDepsEmpty,
  isDepsError,
} from './schema.ts'
export type {
  DepsState as DepsStateType,
  DepsAction as DepsActionType,
  DepsMember as DepsMemberType,
  DownstreamRef as DownstreamRefType,
} from './schema.ts'

// App
export { DepsApp, createInitialDepsState } from './app.ts'

// Views
export { DepsView, type DepsViewProps } from './view.tsx'
