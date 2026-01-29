/**
 * Deploy View Stories
 *
 * Demonstrates a deploy CLI view component with all state variations
 * and output mode controls.
 */

import type { Meta, StoryObj } from '@storybook/react'
import { SubscriptionRef, Effect } from 'effect'
import React, { useEffect, useState, useRef } from 'react'

import { Box, Text, Spinner, Static, useSubscriptionRef } from '../../mod.ts'
import { StringTerminalPreview } from '../StringTerminalPreview.tsx'
import { TerminalPreview } from '../TerminalPreview.tsx'

// =============================================================================
// Types (inline to avoid tsconfig issues with examples/)
// =============================================================================

interface LogEntry {
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  service?: string
}

interface ServiceProgress {
  name: string
  status: 'pending' | 'pulling' | 'starting' | 'healthcheck' | 'healthy' | 'failed'
  message?: string
}

interface ServiceResult {
  name: string
  result: 'updated' | 'unchanged' | 'rolled-back' | 'failed'
  duration: number
  error?: string
}

type DeployState =
  | { _tag: 'Idle' }
  | { _tag: 'Validating'; environment: string; services: string[]; logs: LogEntry[] }
  | {
      _tag: 'Progress'
      environment: string
      services: ServiceProgress[]
      logs: LogEntry[]
      startedAt: number
    }
  | {
      _tag: 'Complete'
      environment: string
      services: ServiceResult[]
      logs: LogEntry[]
      startedAt: number
      completedAt: number
      totalDuration: number
    }
  | {
      _tag: 'Failed'
      environment: string
      services: ServiceResult[]
      error: string
      logs: LogEntry[]
      startedAt: number
      failedAt: number
    }
  | {
      _tag: 'RollingBack'
      environment: string
      services: ServiceProgress[]
      reason: string
      logs: LogEntry[]
      startedAt: number
    }

/**
 * Props for the DeployView component.
 * Uses stateRef pattern for direct SubscriptionRef subscription.
 */
interface DeployViewProps {
  stateRef: SubscriptionRef.SubscriptionRef<DeployState>
}

// =============================================================================
// View Components (inline to avoid tsconfig issues)
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

const ProgressSummary = ({ services }: { services: ServiceProgress[] }) => {
  const completed = services.filter((s) => s.status === 'healthy').length
  const failed = services.filter((s) => s.status === 'failed').length
  const total = services.length

  return (
    <Box flexDirection="row">
      <Text>Deploying </Text>
      <Text color={failed > 0 ? 'red' : 'green'}>{completed}</Text>
      {failed > 0 && <Text color="red">/{failed} failed</Text>}
      <Text>/{total} services</Text>
    </Box>
  )
}

function DeployView({ stateRef }: DeployViewProps) {
  const state = useSubscriptionRef(stateRef)

  if (state._tag === 'Idle') {
    return <Text dim>Waiting to start...</Text>
  }

  const logs = 'logs' in state ? state.logs : []
  const environment = 'environment' in state ? state.environment : ''

  return (
    <>
      {/* oxlint-disable-next-line overeng/named-args -- React callback signature */}
      <Static items={logs}>{(log, i) => <LogLine key={i} entry={log} />}</Static>

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

      {state._tag === 'Progress' && (
        <Box flexDirection="column">
          <ProgressSummary services={state.services} />
          {state.services.map((service) => (
            <ServiceProgressLine key={service.name} service={service} />
          ))}
        </Box>
      )}

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
    </>
  )
}

// =============================================================================
// Sample Data
// =============================================================================

const sampleLogs: LogEntry[] = [
  { timestamp: '10:15:30', level: 'info', message: 'Starting deployment to production' },
  { timestamp: '10:15:30', level: 'info', message: 'Services: api, web, worker' },
  { timestamp: '10:15:31', level: 'info', message: 'Configuration validated' },
]

const sampleServicesInProgress: ServiceProgress[] = [
  { name: 'api', status: 'healthy' },
  { name: 'web', status: 'starting', message: 'Starting container...' },
  { name: 'worker', status: 'pending' },
]

const sampleServicesComplete: ServiceResult[] = [
  { name: 'api', result: 'updated', duration: 1234 },
  { name: 'web', result: 'updated', duration: 2100 },
  { name: 'worker', result: 'unchanged', duration: 500 },
]

const sampleServicesFailed: ServiceResult[] = [
  { name: 'api', result: 'updated', duration: 1234 },
  { name: 'web', result: 'failed', duration: 3000, error: 'Health check timeout' },
  { name: 'worker', result: 'rolled-back', duration: 800 },
]

// =============================================================================
// State Factories
// =============================================================================

const createIdleState = (): DeployState => ({ _tag: 'Idle' })

const createValidatingState = (): DeployState => ({
  _tag: 'Validating',
  environment: 'production',
  services: ['api', 'web', 'worker'],
  logs: sampleLogs.slice(0, 2),
})

const createProgressState = (): DeployState => ({
  _tag: 'Progress',
  environment: 'production',
  services: sampleServicesInProgress,
  logs: sampleLogs,
  startedAt: Date.now() - 5000,
})

const createCompleteState = (): DeployState => ({
  _tag: 'Complete',
  environment: 'production',
  services: sampleServicesComplete,
  logs: [
    ...sampleLogs,
    { timestamp: '10:15:35', level: 'info', message: 'Deployed successfully', service: 'api' },
    { timestamp: '10:15:37', level: 'info', message: 'Deployed successfully', service: 'web' },
    { timestamp: '10:15:38', level: 'info', message: 'Service unchanged', service: 'worker' },
    { timestamp: '10:15:38', level: 'info', message: 'Deployment complete in 8.2s' },
  ],
  startedAt: Date.now() - 8200,
  completedAt: Date.now(),
  totalDuration: 8200,
})

const createFailedState = (): DeployState => ({
  _tag: 'Failed',
  environment: 'production',
  services: sampleServicesFailed,
  error: 'Deployment failed: web service health check timeout after 30s',
  logs: [
    ...sampleLogs,
    { timestamp: '10:15:35', level: 'info', message: 'Deployed successfully', service: 'api' },
    { timestamp: '10:15:40', level: 'error', message: 'Health check failed', service: 'web' },
    { timestamp: '10:15:40', level: 'warn', message: 'Rolling back...', service: 'worker' },
  ],
  startedAt: Date.now() - 10000,
  failedAt: Date.now(),
})

const createRollingBackState = (): DeployState => ({
  _tag: 'RollingBack',
  environment: 'production',
  services: [
    { name: 'api', status: 'healthy' },
    { name: 'web', status: 'failed' },
    { name: 'worker', status: 'starting', message: 'Rolling back...' },
  ],
  reason: 'web service health check failed',
  logs: [
    ...sampleLogs,
    { timestamp: '10:15:35', level: 'info', message: 'Deployed successfully', service: 'api' },
    { timestamp: '10:15:40', level: 'error', message: 'Health check failed', service: 'web' },
    { timestamp: '10:15:41', level: 'warn', message: 'Initiating rollback...' },
  ],
  startedAt: Date.now() - 11000,
})

// =============================================================================
// Wrapper Components
// =============================================================================

/**
 * DeployViewWrapper - wraps DeployView with a SubscriptionRef for Storybook
 */
const DeployViewWrapper = ({ state }: { state: DeployState }) => {
  const [stateRef, setStateRef] = useState<SubscriptionRef.SubscriptionRef<DeployState> | null>(
    null,
  )
  const initialStateRef = useRef(state)

  useEffect(() => {
    const program = Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make(initialStateRef.current)
      setStateRef(ref)
      return ref
    })
    Effect.runPromise(program)
  }, [])

  useEffect(() => {
    if (stateRef) {
      Effect.runPromise(SubscriptionRef.set(stateRef, state))
    }
  }, [state, stateRef])

  if (!stateRef) {
    return <Text dim>Loading...</Text>
  }

  return <DeployView stateRef={stateRef} />
}

/**
 * AnimatedDeploySimulation - simulates a full deploy cycle
 */
const AnimatedDeploySimulation = () => {
  const [stateRef, setStateRef] = useState<SubscriptionRef.SubscriptionRef<DeployState> | null>(
    null,
  )

  useEffect(() => {
    const program = Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<DeployState>({ _tag: 'Idle' })
      setStateRef(ref)
      return ref
    })
    Effect.runPromise(program)
  }, [])

  useEffect(() => {
    if (!stateRef) return

    const states: DeployState[] = [
      createValidatingState(),
      {
        _tag: 'Progress',
        environment: 'production',
        services: [
          { name: 'api', status: 'pulling', message: 'Pulling image...' },
          { name: 'web', status: 'pending' },
          { name: 'worker', status: 'pending' },
        ],
        logs: sampleLogs,
        startedAt: Date.now(),
      },
      {
        _tag: 'Progress',
        environment: 'production',
        services: [
          { name: 'api', status: 'starting', message: 'Starting container...' },
          { name: 'web', status: 'pulling', message: 'Pulling image...' },
          { name: 'worker', status: 'pending' },
        ],
        logs: sampleLogs,
        startedAt: Date.now(),
      },
      {
        _tag: 'Progress',
        environment: 'production',
        services: [
          { name: 'api', status: 'healthcheck', message: 'Health check...' },
          { name: 'web', status: 'starting', message: 'Starting container...' },
          { name: 'worker', status: 'pulling', message: 'Pulling image...' },
        ],
        logs: sampleLogs,
        startedAt: Date.now(),
      },
      {
        _tag: 'Progress',
        environment: 'production',
        services: [
          { name: 'api', status: 'healthy' },
          { name: 'web', status: 'healthcheck', message: 'Health check...' },
          { name: 'worker', status: 'starting', message: 'Starting container...' },
        ],
        logs: [
          ...sampleLogs,
          {
            timestamp: '10:15:35',
            level: 'info',
            message: 'Deployed successfully',
            service: 'api',
          },
        ],
        startedAt: Date.now(),
      },
      {
        _tag: 'Progress',
        environment: 'production',
        services: [
          { name: 'api', status: 'healthy' },
          { name: 'web', status: 'healthy' },
          { name: 'worker', status: 'healthcheck', message: 'Health check...' },
        ],
        logs: [
          ...sampleLogs,
          {
            timestamp: '10:15:35',
            level: 'info',
            message: 'Deployed successfully',
            service: 'api',
          },
          {
            timestamp: '10:15:37',
            level: 'info',
            message: 'Deployed successfully',
            service: 'web',
          },
        ],
        startedAt: Date.now(),
      },
      createCompleteState(),
    ]

    let index = 0
    const interval = setInterval(() => {
      if (index < states.length) {
        Effect.runPromise(SubscriptionRef.set(stateRef, states[index]!))
        index++
      } else {
        index = 0 // Loop
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [stateRef])

  if (!stateRef) {
    return <Text dim>Loading...</Text>
  }

  return <DeployView stateRef={stateRef} />
}

/**
 * JsonPreview - shows what the JSON output would look like (uses HTML div, not TUI Box)
 */
const JsonPreview = ({ state }: { state: DeployState }) => {
  const jsonOutput = JSON.stringify(state, null, 2)

  return (
    <div
      style={{
        padding: '16px',
        backgroundColor: '#1e1e1e',
        borderRadius: '8px',
        fontFamily: 'Monaco, Menlo, monospace',
        fontSize: '13px',
        color: '#d4d4d4',
        whiteSpace: 'pre',
        overflow: 'auto',
        maxHeight: '500px',
      }}
    >
      <pre style={{ margin: 0 }}>{jsonOutput}</pre>
    </div>
  )
}

// =============================================================================
// Story Meta
// =============================================================================

interface DeployViewStoryArgs {
  renderMode: 'tty' | 'string' | 'json'
  deployState:
    | 'idle'
    | 'validating'
    | 'progress'
    | 'complete'
    | 'failed'
    | 'rolling-back'
    | 'animated'
}

const stateMap = {
  idle: createIdleState,
  validating: createValidatingState,
  progress: createProgressState,
  complete: createCompleteState,
  failed: createFailedState,
  'rolling-back': createRollingBackState,
}

const meta: Meta<DeployViewStoryArgs> = {
  title: 'Examples/Deploy CLI',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Deploy CLI view demonstrating progressive rendering with createTuiApp. Supports multiple output modes: TTY (interactive), string (non-TTY), and JSON.',
      },
    },
  },
  argTypes: {
    renderMode: {
      description: 'Output mode for the CLI',
      control: { type: 'radio' },
      options: ['tty', 'string', 'json'],
      table: { category: 'Output Mode' },
    },
    deployState: {
      description: 'Current state of the deploy process',
      control: { type: 'select' },
      options: ['idle', 'validating', 'progress', 'complete', 'failed', 'rolling-back', 'animated'],
      table: { category: 'Deploy State' },
    },
  },
  args: {
    renderMode: 'tty',
    deployState: 'progress',
  },
  render: (args) => {
    const { renderMode, deployState } = args

    if (deployState === 'animated') {
      return (
        <TerminalPreview height={400}>
          <AnimatedDeploySimulation />
        </TerminalPreview>
      )
    }

    const state = stateMap[deployState]()

    if (renderMode === 'json') {
      return <JsonPreview state={state} />
    }

    if (renderMode === 'string') {
      return <StringTerminalPreview component={DeployViewWrapper} props={{ state }} height={400} />
    }

    return (
      <TerminalPreview height={400}>
        <DeployViewWrapper state={state} />
      </TerminalPreview>
    )
  },
}

export default meta
type Story = StoryObj<DeployViewStoryArgs>

// =============================================================================
// Stories
// =============================================================================

/** Interactive deploy progress with spinner animations */
export const Progress: Story = {
  args: {
    renderMode: 'tty',
    deployState: 'progress',
  },
}

/** Successful deployment completion */
export const Complete: Story = {
  args: {
    renderMode: 'tty',
    deployState: 'complete',
  },
}

/** Failed deployment with error details */
export const Failed: Story = {
  args: {
    renderMode: 'tty',
    deployState: 'failed',
  },
}

/** Rollback in progress after failure */
export const RollingBack: Story = {
  args: {
    renderMode: 'tty',
    deployState: 'rolling-back',
  },
}

/** Full animated deployment simulation */
export const Animated: Story = {
  args: {
    renderMode: 'tty',
    deployState: 'animated',
  },
  parameters: {
    docs: {
      description: {
        story: 'Animated simulation showing a complete deploy cycle with all state transitions.',
      },
    },
  },
}

/** JSON output mode (final-json) */
export const JsonOutput: Story = {
  args: {
    renderMode: 'json',
    deployState: 'complete',
  },
  parameters: {
    docs: {
      description: {
        story: 'Shows what the JSON output looks like when using --json flag.',
      },
    },
  },
}

/** String (non-TTY) output mode */
export const StringOutput: Story = {
  args: {
    renderMode: 'string',
    deployState: 'complete',
  },
  parameters: {
    docs: {
      description: {
        story: 'Shows the string output for non-TTY environments (piped output).',
      },
    },
  },
}

/** Validating configuration before deploy */
export const Validating: Story = {
  args: {
    renderMode: 'tty',
    deployState: 'validating',
  },
}

/** Idle state before deploy starts */
export const Idle: Story = {
  args: {
    renderMode: 'tty',
    deployState: 'idle',
  },
}
