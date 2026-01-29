/**
 * Deploy CLI State Schema
 *
 * Defines the state structure for the deploy command.
 * Used for both visual rendering and JSON serialization.
 */

import { Schema } from 'effect'

// =============================================================================
// Service Status
// =============================================================================

export const ServiceStatus = Schema.Literal(
  'pending',
  'pulling',
  'starting',
  'healthcheck',
  'healthy',
  'failed',
)
export type ServiceStatus = Schema.Schema.Type<typeof ServiceStatus>

// =============================================================================
// Service Definitions
// =============================================================================

export const ServiceProgress = Schema.Struct({
  name: Schema.String,
  status: ServiceStatus,
  message: Schema.optional(Schema.String),
})
export type ServiceProgress = Schema.Schema.Type<typeof ServiceProgress>

export const ServiceResult = Schema.Struct({
  name: Schema.String,
  result: Schema.Literal('updated', 'unchanged', 'rolled-back', 'failed'),
  duration: Schema.Number,
  error: Schema.optional(Schema.String),
})
export type ServiceResult = Schema.Schema.Type<typeof ServiceResult>

// =============================================================================
// Log Entry
// =============================================================================

export const LogEntry = Schema.Struct({
  timestamp: Schema.String,
  level: Schema.Literal('info', 'warn', 'error', 'debug'),
  message: Schema.String,
  service: Schema.optional(Schema.String),
})
export type LogEntry = Schema.Schema.Type<typeof LogEntry>

// =============================================================================
// Deploy State
// =============================================================================

export const DeployState = Schema.Union(
  Schema.TaggedStruct('Idle', {}),

  Schema.TaggedStruct('Validating', {
    environment: Schema.String,
    services: Schema.Array(Schema.String),
    logs: Schema.Array(LogEntry),
  }),

  Schema.TaggedStruct('Progress', {
    environment: Schema.String,
    services: Schema.Array(ServiceProgress),
    logs: Schema.Array(LogEntry),
    startedAt: Schema.Number,
  }),

  Schema.TaggedStruct('Complete', {
    environment: Schema.String,
    services: Schema.Array(ServiceResult),
    logs: Schema.Array(LogEntry),
    startedAt: Schema.Number,
    completedAt: Schema.Number,
    totalDuration: Schema.Number,
  }),

  Schema.TaggedStruct('Failed', {
    environment: Schema.String,
    services: Schema.Array(ServiceResult),
    error: Schema.String,
    logs: Schema.Array(LogEntry),
    startedAt: Schema.Number,
    failedAt: Schema.Number,
  }),

  Schema.TaggedStruct('RollingBack', {
    environment: Schema.String,
    services: Schema.Array(ServiceProgress),
    reason: Schema.String,
    logs: Schema.Array(LogEntry),
    startedAt: Schema.Number,
  }),

  Schema.TaggedStruct('Interrupted', {
    environment: Schema.String,
    services: Schema.Array(ServiceResult),
    logs: Schema.Array(LogEntry),
    startedAt: Schema.Number,
    interruptedAt: Schema.Number,
  }),
)

export type DeployState = Schema.Schema.Type<typeof DeployState>

// =============================================================================
// Deploy Options
// =============================================================================

export const DeployOptions = Schema.Struct({
  services: Schema.Array(Schema.String),
  environment: Schema.String,
  dryRun: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  force: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  timeout: Schema.optionalWith(Schema.Number, { default: () => 30000 }),
})
export type DeployOptions = Schema.Schema.Type<typeof DeployOptions>

// =============================================================================
// Deploy Result (for programmatic use)
// =============================================================================

export const DeployResult = Schema.Struct({
  success: Schema.Boolean,
  services: Schema.Array(ServiceResult),
  totalDuration: Schema.Number,
  error: Schema.optional(Schema.String),
})
export type DeployResult = Schema.Schema.Type<typeof DeployResult>

// =============================================================================
// Deploy Actions (for reducer pattern)
// =============================================================================

export const DeployAction = Schema.Union(
  // Direct state transitions
  Schema.TaggedStruct('SetState', { state: DeployState }),

  // Granular updates (for Progress state)
  Schema.TaggedStruct('UpdateServiceStatus', {
    index: Schema.Number,
    status: ServiceStatus,
    message: Schema.optional(Schema.String),
  }),

  // Add a log entry
  Schema.TaggedStruct('AddLog', { log: LogEntry }),

  // Interrupt handling (auto-dispatched on Ctrl+C)
  Schema.TaggedStruct('Interrupted', {}),
)

export type DeployAction = Schema.Schema.Type<typeof DeployAction>

// =============================================================================
// Deploy Reducer
// =============================================================================

const timestamp = () => new Date().toISOString().slice(11, 19)

export const deployReducer = ({
  state,
  action,
}: {
  state: DeployState
  action: DeployAction
}): DeployState => {
  switch (action._tag) {
    case 'SetState':
      return action.state

    case 'UpdateServiceStatus':
      if (state._tag !== 'Progress') return state
      return {
        ...state,
        services: state.services.map((svc, idx) =>
          idx === action.index ? { ...svc, status: action.status, message: action.message } : svc,
        ),
      }

    case 'AddLog':
      if (!('logs' in state)) return state
      return {
        ...state,
        logs: [...state.logs, action.log],
      } as DeployState

    case 'Interrupted': {
      // Only handle interrupt during active states
      if (
        state._tag !== 'Validating' &&
        state._tag !== 'Progress' &&
        state._tag !== 'RollingBack'
      ) {
        return state
      }

      const logs = 'logs' in state ? state.logs : []
      const environment = 'environment' in state ? state.environment : ''
      const startedAt = 'startedAt' in state ? state.startedAt : Date.now()

      // Convert current service progress to results
      const services: ServiceResult[] =
        state._tag === 'Progress'
          ? state.services.map((svc) => ({
              name: svc.name,
              result:
                svc.status === 'healthy'
                  ? ('updated' as const)
                  : svc.status === 'failed'
                    ? ('failed' as const)
                    : ('unchanged' as const),
              duration: 0,
            }))
          : []

      return {
        _tag: 'Interrupted',
        environment,
        services,
        logs: [
          ...logs,
          { timestamp: timestamp(), level: 'warn', message: 'Deployment interrupted by user' },
        ],
        startedAt,
        interruptedAt: Date.now(),
      }
    }
  }
}
