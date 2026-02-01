/**
 * InitOutput Module
 */

// Schema
export { InitState, InitAction, initReducer, isInitError, isInitSuccess, isInitAlready } from './schema.ts'
export type { InitState as InitStateType, InitAction as InitActionType } from './schema.ts'

// App
export { InitApp, createInitialInitState } from './app.ts'

// Views
export { InitView, type InitViewProps } from './view.tsx'
export { InitConnectedView } from './connected-view.tsx'
