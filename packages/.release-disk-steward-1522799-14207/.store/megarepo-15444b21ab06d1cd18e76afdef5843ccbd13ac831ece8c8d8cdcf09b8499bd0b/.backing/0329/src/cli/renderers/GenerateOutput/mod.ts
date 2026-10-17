/**
 * GenerateOutput Module
 */

// Schema
export {
  GenerateState,
  GenerateAction,
  generateReducer,
  isGenerateError,
  isGenerateSuccess,
  isGenerateRunning,
  isGenerateIdle,
  GenerateResultItem,
} from './schema.ts'
export type {
  GenerateState as GenerateStateType,
  GenerateAction as GenerateActionType,
  GenerateResultItem as GenerateResultItemType,
} from './schema.ts'

// App
export { GenerateApp, createInitialGenerateState } from './app.ts'

// Views
export { GenerateView, type GenerateViewProps } from './view.tsx'
