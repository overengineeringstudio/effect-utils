/**
 * Deploy CLI View Component
 */

import { Atom } from '@effect-atom/atom'
import React, { useMemo } from 'react'

import { Box, Text, Spinner, Static, useTuiAtomValue } from '../../../src/mod.ts'
import type { DeployState, LogEntry, ServiceProgress, ServiceResult } from './schema.ts'

// =============================================================================
// Main View
// =============================================================================

export const DeployView = ({ stateAtom }: { stateAtom: Atom.Atom<DeployState> }) => {
  // Derive atoms for routing and shared data
  const tagAtom = useMemo(() => Atom.map(stateAtom, (s) => s._tag), [stateAtom])
  const logsAtom = useMemo(
    () => Atom.map(stateAtom, (s): readonly LogEntry[] => ('logs' in s ? s.logs : [])),
    [stateAtom],
  )
  const environmentAtom = useMemo(
    () => Atom.map(stateAtom, (s) => ('environment' in s ? s.environment : '')),
    [stateAtom],
  )

  const tag = useTuiAtomValue(tagAtom)
  const logs = useTuiAtomValue(logsAtom)
  const environment = useTuiAtomValue(environmentAtom)

  if (tag === 'Idle') {
    return <Text dim>Waiting to start...</Text>
  }

  return (
    <>
      {/* Static log region */}
      {/* oxlint-disable-next-line overeng/named-args -- React callback signature */}
      <Static items={logs}>{(log, i) => <LogLine key={i} entry={log} />}</Static>

      {/* Validating state */}
      {tag === 'Validating' && (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Spinner type="dots" />
            <Text> Validating deployment to </Text>
            <Text bold>{environment}</Text>
            <Text>...</Text>
          </Box>
        </Box>
      )}

      {/* Progress state - uses derived atom for services */}
      {tag === 'Progress' && <ProgressSection stateAtom={stateAtom} />}

      {/* Rolling back state */}
      {tag === 'RollingBack' && <RollingBackSection stateAtom={stateAtom} />}

      {/* Complete state */}
      {tag === 'Complete' && <CompleteSection stateAtom={stateAtom} />}

      {/* Failed state */}
      {tag === 'Failed' && <FailedSection stateAtom={stateAtom} />}

      {/* Interrupted state */}
      {tag === 'Interrupted' && <InterruptedSection stateAtom={stateAtom} />}
    </>
  )
}

// =============================================================================
// Internal Components
// =============================================================================

function StatusIcon({ status }: { status: ServiceProgress['status'] }) {
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

function ResultIcon({ result }: { result: ServiceResult['result'] }) {
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

function LogLine({ entry }: { entry: LogEntry }) {
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

function ServiceProgressLine({ service }: { service: ServiceProgress }) {
  return (
    <Box flexDirection="row" paddingLeft={2}>
      <StatusIcon status={service.status} />
      <Text>{service.name}</Text>
      {service.status !== 'pending' && service.status !== 'healthy' && (
        <Text dim> ({service.status})</Text>
      )}
      {service.message && <Text dim> - {service.message}</Text>}
    </Box>
  )
}

function ServiceResultLine({ service }: { service: ServiceResult }) {
  return (
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
}

function ProgressSection({ stateAtom }: { stateAtom: Atom.Atom<DeployState> }) {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'Progress') return null

  const services = state.services
  const completed = services.filter((s) => s.status === 'healthy').length
  const failed = services.filter((s) => s.status === 'failed').length
  const total = services.length

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text>Deploying </Text>
        <Text color={failed > 0 ? 'red' : 'green'}>{completed}</Text>
        {failed > 0 && <Text color="red">/{failed} failed</Text>}
        <Text>/{total} services</Text>
      </Box>
      {services.map((service) => (
        <ServiceProgressLine key={service.name} service={service} />
      ))}
    </Box>
  )
}

function RollingBackSection({ stateAtom }: { stateAtom: Atom.Atom<DeployState> }) {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'RollingBack') return null

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="yellow">↩ Rolling back: </Text>
        <Text>{state.reason}</Text>
      </Box>
      {state.services.map((service) => (
        <ServiceProgressLine key={service.name} service={service} />
      ))}
    </Box>
  )
}

function CompleteSection({ stateAtom }: { stateAtom: Atom.Atom<DeployState> }) {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'Complete') return null

  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        ✓ Deploy complete
      </Text>
      {state.services.map((service) => (
        <ServiceResultLine key={service.name} service={service} />
      ))}
      <Text dim>
        {'\n'}
        {state.services.length} services deployed to {state.environment} in{' '}
        {(state.totalDuration / 1000).toFixed(1)}s
      </Text>
    </Box>
  )
}

function FailedSection({ stateAtom }: { stateAtom: Atom.Atom<DeployState> }) {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'Failed') return null

  return (
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
  )
}

function InterruptedSection({ stateAtom }: { stateAtom: Atom.Atom<DeployState> }) {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag !== 'Interrupted') return null

  return (
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
        {'\n'}Duration before interrupt: {((state.interruptedAt - state.startedAt) / 1000).toFixed(
          1,
        )}
        s
      </Text>
    </Box>
  )
}
