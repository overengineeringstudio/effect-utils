/**
 * Deploy CLI - Storybook Stories
 *
 * Demonstrates the deploy CLI view using TuiStoryPreview with all output modes.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview, type OutputTab } from '../../../src/storybook/TuiStoryPreview.tsx'
import { DeployView } from './view.tsx'
import { DeployState, DeployAction, deployReducer, type LogEntry } from './schema.ts'

// =============================================================================
// Sample Data
// =============================================================================

const sampleLogs: readonly LogEntry[] = [
  { timestamp: '10:15:30', level: 'info', message: 'Starting deployment to production' },
  { timestamp: '10:15:30', level: 'info', message: 'Services: api, web, worker' },
  { timestamp: '10:15:31', level: 'info', message: 'Configuration validated' },
]

// =============================================================================
// State Factories
// =============================================================================

const createIdleState = (): typeof DeployState.Type => ({ _tag: 'Idle' })

const createValidatingState = (): typeof DeployState.Type => ({
  _tag: 'Validating',
  environment: 'production',
  services: ['api', 'web', 'worker'],
  logs: [...sampleLogs.slice(0, 2)],
})

const createProgressState = (): typeof DeployState.Type => ({
  _tag: 'Progress',
  environment: 'production',
  services: [
    { name: 'api', status: 'healthy' },
    { name: 'web', status: 'starting', message: 'Starting container...' },
    { name: 'worker', status: 'pending' },
  ],
  logs: [...sampleLogs],
  startedAt: Date.now() - 5000,
})

const createCompleteState = (): typeof DeployState.Type => ({
  _tag: 'Complete',
  environment: 'production',
  services: [
    { name: 'api', result: 'updated', duration: 1234 },
    { name: 'web', result: 'updated', duration: 2100 },
    { name: 'worker', result: 'unchanged', duration: 500 },
  ],
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

const createFailedState = (): typeof DeployState.Type => ({
  _tag: 'Failed',
  environment: 'production',
  services: [
    { name: 'api', result: 'updated', duration: 1234 },
    { name: 'web', result: 'failed', duration: 3000, error: 'Health check timeout' },
    { name: 'worker', result: 'rolled-back', duration: 800 },
  ],
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

const createRollingBackState = (): typeof DeployState.Type => ({
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
// Timeline for Animated Story
// =============================================================================

const deployTimeline: Array<{ at: number; action: typeof DeployAction.Type }> = [
  // Start validating
  { at: 0, action: { _tag: 'SetState', state: createValidatingState() } },

  // Start progress
  {
    at: 1000,
    action: {
      _tag: 'SetState',
      state: {
        _tag: 'Progress',
        environment: 'production',
        services: [
          { name: 'api', status: 'pulling', message: 'Pulling image...' },
          { name: 'web', status: 'pending' },
          { name: 'worker', status: 'pending' },
        ],
        logs: [...sampleLogs],
        startedAt: Date.now(),
      },
    },
  },

  // Progress updates
  {
    at: 2000,
    action: {
      _tag: 'SetState',
      state: {
        _tag: 'Progress',
        environment: 'production',
        services: [
          { name: 'api', status: 'starting', message: 'Starting container...' },
          { name: 'web', status: 'pulling', message: 'Pulling image...' },
          { name: 'worker', status: 'pending' },
        ],
        logs: [...sampleLogs],
        startedAt: Date.now(),
      },
    },
  },

  {
    at: 3000,
    action: {
      _tag: 'SetState',
      state: {
        _tag: 'Progress',
        environment: 'production',
        services: [
          { name: 'api', status: 'healthcheck', message: 'Health check...' },
          { name: 'web', status: 'starting', message: 'Starting container...' },
          { name: 'worker', status: 'pulling', message: 'Pulling image...' },
        ],
        logs: [...sampleLogs],
        startedAt: Date.now(),
      },
    },
  },

  {
    at: 4000,
    action: {
      _tag: 'SetState',
      state: {
        _tag: 'Progress',
        environment: 'production',
        services: [
          { name: 'api', status: 'healthy' },
          { name: 'web', status: 'healthcheck', message: 'Health check...' },
          { name: 'worker', status: 'starting', message: 'Starting container...' },
        ],
        logs: [
          ...sampleLogs,
          { timestamp: '10:15:35', level: 'info', message: 'Deployed successfully', service: 'api' },
        ],
        startedAt: Date.now(),
      },
    },
  },

  {
    at: 5000,
    action: {
      _tag: 'SetState',
      state: {
        _tag: 'Progress',
        environment: 'production',
        services: [
          { name: 'api', status: 'healthy' },
          { name: 'web', status: 'healthy' },
          { name: 'worker', status: 'healthcheck', message: 'Health check...' },
        ],
        logs: [
          ...sampleLogs,
          { timestamp: '10:15:35', level: 'info', message: 'Deployed successfully', service: 'api' },
          { timestamp: '10:15:37', level: 'info', message: 'Deployed successfully', service: 'web' },
        ],
        startedAt: Date.now(),
      },
    },
  },

  // Complete
  { at: 6000, action: { _tag: 'SetState', state: createCompleteState() } },
]

// =============================================================================
// Story Meta
// =============================================================================

const ALL_TABS: OutputTab[] = ['tty', 'alt-screen', 'ci', 'ci-plain', 'pipe', 'log', 'json', 'ndjson']

const meta: Meta = {
  title: 'Examples/03 CLI/Deploy',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
Deploy CLI view demonstrating progressive rendering with TuiStoryPreview.

**Demonstrates:**
- Progressive deployment status updates
- Service health states (pending, pulling, starting, healthy, failed)
- Log streaming with Static component
- Error handling and rollback states
- All output modes: Visual, Fullscreen, String, JSON, NDJSON

**CLI Usage:**
\`\`\`bash
bun examples/03-cli/deploy/main.ts --environment production --services api,web,worker
bun examples/03-cli/deploy/main.ts --dry-run
\`\`\`
        `,
      },
    },
  },
}

export default meta

// =============================================================================
// Stories
// =============================================================================

type Story = StoryObj<{
  autoRun: boolean
  playbackSpeed: number
  height: number
}>

/** Full animated deployment simulation with all output modes */
export const Demo: Story = {
  args: {
    autoRun: true,
    playbackSpeed: 1,
    height: 400,
  },
  argTypes: {
    autoRun: {
      description: 'Auto-start timeline playback',
      control: { type: 'boolean' },
    },
    playbackSpeed: {
      description: 'Playback speed multiplier',
      control: { type: 'range', min: 0.5, max: 3, step: 0.5 },
    },
    height: {
      description: 'Terminal height in pixels',
      control: { type: 'range', min: 200, max: 600, step: 50 },
    },
  },
  render: (args) => (
    <TuiStoryPreview
      View={DeployView}
      stateSchema={DeployState}
      actionSchema={DeployAction}
      reducer={deployReducer}
      initialState={createIdleState()}
      timeline={deployTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Interactive deploy progress with spinner animations */
export const Progress: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={DeployView}
      stateSchema={DeployState}
      actionSchema={DeployAction}
      reducer={deployReducer}
      initialState={createProgressState()}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

/** Successful deployment completion */
export const Complete: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={DeployView}
      stateSchema={DeployState}
      actionSchema={DeployAction}
      reducer={deployReducer}
      initialState={createCompleteState()}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

/** Failed deployment with error details */
export const Failed: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={DeployView}
      stateSchema={DeployState}
      actionSchema={DeployAction}
      reducer={deployReducer}
      initialState={createFailedState()}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

/** Rollback in progress after failure */
export const RollingBack: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={DeployView}
      stateSchema={DeployState}
      actionSchema={DeployAction}
      reducer={deployReducer}
      initialState={createRollingBackState()}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

/** Validating configuration before deploy */
export const Validating: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={DeployView}
      stateSchema={DeployState}
      actionSchema={DeployAction}
      reducer={deployReducer}
      initialState={createValidatingState()}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

/** Idle state before deploy starts */
export const Idle: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={DeployView}
      stateSchema={DeployState}
      actionSchema={DeployAction}
      reducer={deployReducer}
      initialState={createIdleState()}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

// =============================================================================
// Edge Case Stories - Long Lines
// =============================================================================

const longServiceNames = [
  'api-gateway-service-with-very-long-name-that-exceeds-normal-terminal-width',
  'authentication-and-authorization-microservice-with-oauth2-and-saml-support',
  'background-job-worker-processor-service-for-async-tasks-and-scheduled-jobs',
]

const longLogsBase: readonly LogEntry[] = [
  { timestamp: '10:15:30', level: 'info', message: 'Starting deployment to production-us-east-1-kubernetes-cluster-primary environment with rolling update strategy (maxUnavailable: 25%, maxSurge: 25%)' },
  { timestamp: '10:15:30', level: 'info', message: `Services to deploy: ${longServiceNames.join(', ')}` },
  { timestamp: '10:15:31', level: 'info', message: 'Configuration validated successfully. Found 3 services with 12 replicas total across 4 availability zones. Using container registry: gcr.io/my-organization-production-12345/services' },
]

const longLinesTimeline: Array<{ at: number; action: typeof DeployAction.Type }> = [
  // Start - Idle
  { at: 0, action: { _tag: 'SetState', state: { _tag: 'Idle' } } },

  // Validating with long env name
  {
    at: 500,
    action: {
      _tag: 'SetState',
      state: {
        _tag: 'Validating',
        environment: 'production-us-east-1-kubernetes-cluster-primary',
        services: longServiceNames,
        logs: [longLogsBase[0]!, longLogsBase[1]!],
      },
    },
  },

  // Progress - first service starting
  {
    at: 2000,
    action: {
      _tag: 'SetState',
      state: {
        _tag: 'Progress',
        environment: 'production-us-east-1-kubernetes-cluster-primary',
        services: [
          { name: longServiceNames[0]!, status: 'pulling', message: 'Pulling image gcr.io/my-organization-production-12345/api-gateway:v2.34.1-alpine-slim...' },
          { name: longServiceNames[1]!, status: 'pending' },
          { name: longServiceNames[2]!, status: 'pending' },
        ],
        logs: [...longLogsBase],
        startedAt: Date.now(),
      },
    },
  },

  // Progress - first healthy, second starting with long message
  {
    at: 4000,
    action: {
      _tag: 'SetState',
      state: {
        _tag: 'Progress',
        environment: 'production-us-east-1-kubernetes-cluster-primary',
        services: [
          { name: longServiceNames[0]!, status: 'healthy' },
          { name: longServiceNames[1]!, status: 'healthcheck', message: 'Waiting for health check endpoint GET /api/v1/health/ready to return 200 OK...' },
          { name: longServiceNames[2]!, status: 'pulling', message: 'Pulling image gcr.io/my-organization-production-12345/background-worker:v1.12.0...' },
        ],
        logs: [
          ...longLogsBase,
          { timestamp: '10:15:35', level: 'info', message: `Successfully deployed ${longServiceNames[0]} to all 4 replicas in us-east-1a, us-east-1b, us-east-1c, us-east-1d`, service: longServiceNames[0] },
        ],
        startedAt: Date.now(),
      },
    },
  },

  // Progress - second failing with long error
  {
    at: 6000,
    action: {
      _tag: 'SetState',
      state: {
        _tag: 'Progress',
        environment: 'production-us-east-1-kubernetes-cluster-primary',
        services: [
          { name: longServiceNames[0]!, status: 'healthy' },
          { name: longServiceNames[1]!, status: 'failed' },
          { name: longServiceNames[2]!, status: 'starting', message: 'Starting container with environment variables from ConfigMap/auth-service-config and Secret/auth-service-credentials...' },
        ],
        logs: [
          ...longLogsBase,
          { timestamp: '10:15:35', level: 'info', message: `Successfully deployed ${longServiceNames[0]} to all 4 replicas`, service: longServiceNames[0] },
          { timestamp: '10:15:40', level: 'error', message: 'Health check failed: GET http://10.0.42.156:8080/api/v1/health/ready returned ECONNREFUSED after 30000ms. Container logs: "Error: Unable to connect to Redis cluster at redis-primary.internal.production.svc.cluster.local:6379 - CLUSTERDOWN The cluster is down. Please check Redis Sentinel configuration."', service: longServiceNames[1] },
        ],
        startedAt: Date.now(),
      },
    },
  },

  // Failed state with long error message
  {
    at: 8000,
    action: {
      _tag: 'SetState',
      state: {
        _tag: 'Failed',
        environment: 'production-us-east-1-kubernetes-cluster-primary',
        services: [
          { name: longServiceNames[0]!, result: 'updated', duration: 4500 },
          { name: longServiceNames[1]!, result: 'failed', duration: 5000, error: 'Health check timeout: GET /api/v1/health/ready failed after 30s. Last response: ECONNREFUSED 10.0.42.156:8080. Check container logs for details.' },
          { name: longServiceNames[2]!, result: 'rolled-back', duration: 2000 },
        ],
        error: 'Deployment failed: authentication-and-authorization-microservice-with-oauth2-and-saml-support health check timeout after 30s. The service failed to respond to GET /api/v1/health/ready endpoint. Last error: ECONNREFUSED 10.0.42.156:8080. This may indicate the container failed to start or there is a configuration issue. Run: kubectl logs -n production deployment/authentication-and-authorization-microservice-with-oauth2-and-saml-support --tail=100',
        logs: [
          ...longLogsBase,
          { timestamp: '10:15:35', level: 'info', message: `Successfully deployed ${longServiceNames[0]} to all 4 replicas`, service: longServiceNames[0] },
          { timestamp: '10:15:40', level: 'error', message: 'Health check failed: GET http://10.0.42.156:8080/api/v1/health/ready returned ECONNREFUSED after 30000ms timeout', service: longServiceNames[1] },
          { timestamp: '10:15:41', level: 'warn', message: `Initiating automatic rollback for ${longServiceNames[2]} due to deployment failure in dependent service`, service: longServiceNames[2] },
          { timestamp: '10:15:43', level: 'error', message: 'Deployment failed after 8.2s. 1 service updated, 1 service failed, 1 service rolled back. Please check the error details above and container logs for more information.' },
        ],
        startedAt: Date.now() - 8000,
        failedAt: Date.now(),
      },
    },
  },
]

export const LongLines: Story = {
  args: {
    autoRun: true,
    playbackSpeed: 1,
    height: 400,
  },
  render: (args) => (
    <TuiStoryPreview
      View={DeployView}
      stateSchema={DeployState}
      actionSchema={DeployAction}
      reducer={deployReducer}
      initialState={{ _tag: 'Idle' }}
      timeline={longLinesTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}
