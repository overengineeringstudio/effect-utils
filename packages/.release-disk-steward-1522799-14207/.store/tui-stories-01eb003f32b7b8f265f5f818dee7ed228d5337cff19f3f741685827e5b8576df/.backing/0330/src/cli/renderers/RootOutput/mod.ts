/**
 * RootOutput Module
 */

// Schema
export {
  RootState,
  RootAction,
  RootSuccessState,
  RootErrorState,
  rootReducer,
  isRootError,
  isRootSuccess,
} from './schema.ts'
export type { RootState as RootStateType, RootAction as RootActionType } from './schema.ts'

// App
export { RootApp, createInitialRootState } from './app.ts'

// Views
export { RootView, type RootViewProps } from './view.tsx'
