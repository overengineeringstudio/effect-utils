/**
 * AddOutput Module
 */

// Schema
export {
  AddState,
  AddAction,
  addReducer,
  isAddError,
  isAddSuccess,
  isAddIdle,
  isAddAdding,
} from './schema.ts'
export type { AddState as AddStateType, AddAction as AddActionType } from './schema.ts'

// App
export { AddApp, createInitialAddState } from './app.ts'

// Views
export { AddView, type AddViewProps } from './view.tsx'
