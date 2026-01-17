/**
 * Reusable building blocks for terminal UI rendering.
 */

export { InterruptHandler } from './interrupt-handler.ts'
export type { InterruptHandlerConfig } from './interrupt-handler.ts'

export { RenderScheduler } from './render-scheduler.ts'
export type {
  RenderScheduler as RenderSchedulerHandle,
  RenderSchedulerConfig,
} from './render-scheduler.ts'

export { makeTerminalResource, TerminalResource } from './terminal-resource.ts'
export type { TerminalState } from './terminal-resource.ts'
