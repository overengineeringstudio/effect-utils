/**
 * Deploy CLI View Component
 *
 * React component for rendering deploy progress.
 * Uses app-scoped hooks to access TUI state (React-idiomatic pattern).
 */

import React from 'react'

import { Box, Text, Spinner, Static } from '../../../src/mod.ts'
import { DeployApp } from './deploy.tsx'
import type { DeployState, LogEntry, ServiceProgress, ServiceResult } from './schema.ts'

// =============================================================================
// Status Icons
// =============================================================================

const StatusIcon = ({ status }: { status: ServiceProgress['status'] }) => {
  switch (status) {
    case 'pending':
      return <Text dim>○ </Text>
    case 'pulling':
    case 'starting':
    case 'healthcheck':
      return (
        <>
          <Spinner type="dots" />
          <Text> </Text>
        </>
      )
    case 'healthy':
      return <Text color="green">✓ </Text>
    case 'failed':
      return <Text color="red">✗ </Text>
  }
}

const ResultIcon = ({ result }: { result: ServiceResult['result'] }) => {
  switch (result) {
    case 'updated':
      return <Text color="green">✓ </Text>
    case 'unchanged':
      return <Text color="cyan">○ </Text>
    case 'rolled-back':
      return <Text color="yellow">↩ </Text>
    case 'failed':
      return <Text color="red">✗ </Text>
  }
}

// =============================================================================
// Log Entry Component
// =============================================================================

const LogLine = ({ entry }: { entry: LogEntry }) => {
  const levelColor = {
    info: undefined,
    warn: 'yellow',
    error: 'red',
    debug: 'gray',
  }[entry.level] as 'yellow' | 'red' | 'gray' | undefined

  return (
    <Box flexDirection="row">
      <Text dim>[{entry.timestamp}] </Text>
      {entry.service && <Text dim>[{entry.service}] </Text>}
      <Text color={levelColor}>{entry.message}</Text>
    </Box>
  )
}

// =============================================================================
// Service Progress Component
// =============================================================================

const ServiceProgressLine = ({ service }: { service: ServiceProgress }) => (
  <Box flexDirection="row" paddingLeft={2}>
    <StatusIcon status={service.status} />
    <Text>{service.name}</Text>
    {service.status !== 'pending' && service.status !== 'healthy' && (
      <Text dim> ({service.status})</Text>
    )}
    {service.message && <Text dim> - {service.message}</Text>}
  </Box>
)

// =============================================================================
// Service Result Component
// =============================================================================

const ServiceResultLine = ({ service }: { service: ServiceResult }) => (
  <Box flexDirection="row" paddingLeft={2}>
    <ResultIcon result={service.result} />
    <Text>{service.name}</Text>
    <Text dim>
      {' '}
      ({service.result}, {(service.duration / 1000).toFixed(1)}s)
    </Text>
    {service.error && <Text color="red"> - {service.error}</Text>}
  </Box>
)

// =============================================================================
// Progress Summary
// =============================================================================

const ProgressSummary = ({ services }: { services: ServiceProgress[] }) => {
  const completed = services.filter((s) => s.status === 'healthy').length
  const failed = services.filter((s) => s.status === 'failed').length
  const total = services.length

  return (
    <Box flexDirection="row">
      <Text>Deploying </Text>
      <Text color={failed > 0 ? 'red' : 'green'}>{completed}</Text>
      {failed > 0 && (
        <>
          <Text color="red">/{failed} failed</Text>
        </>
      )}
      <Text>/{total} services</Text>
    </Box>
  )
}

// =============================================================================
// Main View Component (uses app-scoped hooks)
// =============================================================================

export const DeployView = () => {
  // App-scoped hook: type is automatically inferred from DeployApp
  const state = DeployApp.useState()

  if (state._tag === 'Idle') {
    return <Text dim>Waiting to start...</Text>
  }

  const logs = 'logs' in state ? state.logs : []
  const environment = 'environment' in state ? state.environment : ''

  return (
    <>
      {/* Static log region */}
      {/* oxlint-disable-next-line overeng/named-args -- React callback signature */}
      <Static items={logs}>{(log, i) => <LogLine key={i} entry={log} />}</Static>

      {/* Validating state */}
      {state._tag === 'Validating' && (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Spinner type="dots" />
            <Text> Validating deployment to </Text>
            <Text bold>{environment}</Text>
            <Text>...</Text>
          </Box>
        </Box>
      )}

      {/* Progress state */}
      {state._tag === 'Progress' && (
        <Box flexDirection="column">
          <ProgressSummary services={state.services} />
          {state.services.map((service) => (
            <ServiceProgressLine key={service.name} service={service} />
          ))}
        </Box>
      )}

      {/* Rolling back state */}
      {state._tag === 'RollingBack' && (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Text color="yellow">↩ Rolling back: </Text>
            <Text>{state.reason}</Text>
          </Box>
          {state.services.map((service) => (
            <ServiceProgressLine key={service.name} service={service} />
          ))}
        </Box>
      )}

      {/* Complete state */}
      {state._tag === 'Complete' && (
        <Box flexDirection="column">
          <Text color="green" bold>
            ✓ Deploy complete
          </Text>
          {state.services.map((service) => (
            <ServiceResultLine key={service.name} service={service} />
          ))}
          <Text dim>
            {'\n'}
            {state.services.length} services deployed to {environment} in{' '}
            {(state.totalDuration / 1000).toFixed(1)}s
          </Text>
        </Box>
      )}

      {/* Failed state */}
      {state._tag === 'Failed' && (
        <Box flexDirection="column">
          <Text color="red" bold>
            ✗ Deploy failed
          </Text>
          <Box paddingLeft={2}>
            <Text color="red">{state.error}</Text>
          </Box>
          {state.services.length > 0 && (
            <>
              <Text dim>{'\n'}Service status:</Text>
              {state.services.map((service) => (
                <ServiceResultLine key={service.name} service={service} />
              ))}
            </>
          )}
        </Box>
      )}

      {/* Interrupted state */}
      {state._tag === 'Interrupted' && (
        <Box flexDirection="column">
          <Text color="yellow" bold>
            ⚠ Deploy interrupted
          </Text>
          <Text dim>Deployment to {state.environment} was cancelled by user (Ctrl+C)</Text>
          {state.services.length > 0 && (
            <>
              <Text dim>{'\n'}Service status at interruption:</Text>
              {state.services.map((service) => (
                <ServiceResultLine key={service.name} service={service} />
              ))}
            </>
          )}
          <Text dim>
            {'\n'}Duration before interrupt:{' '}
            {((state.interruptedAt - state.startedAt) / 1000).toFixed(1)}s
          </Text>
        </Box>
      )}
    </>
  )
}
