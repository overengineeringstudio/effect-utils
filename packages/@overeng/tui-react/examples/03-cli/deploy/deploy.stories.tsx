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

const ALL_TABS: OutputTab[] = ['visual', 'fullscreen', 'string', 'json', 'ndjson']

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
