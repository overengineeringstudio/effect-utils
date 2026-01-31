/**
 * GenieOutput Stories
 *
 * Storybook stories using TuiStoryPreview stateful mode.
 * Supports all output modes: TTY, CI, Log, JSON, NDJSON.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview, type OutputTab } from '@overeng/tui-react/storybook'

import { GenieState, GenieAction, genieReducer } from './schema.ts'
import { GenieView } from './view.tsx'

// =============================================================================
// Sample Data
// =============================================================================

const sampleFiles = [
  { path: '/workspace/packages/foo/package.json', relativePath: 'packages/foo/package.json' },
  { path: '/workspace/packages/foo/tsconfig.json', relativePath: 'packages/foo/tsconfig.json' },
  { path: '/workspace/packages/bar/package.json', relativePath: 'packages/bar/package.json' },
  { path: '/workspace/.github/workflows/ci.yml', relativePath: '.github/workflows/ci.yml' },
  { path: '/workspace/tsconfig.base.json', relativePath: 'tsconfig.base.json' },
]

// =============================================================================
// State Factories
// =============================================================================

const createState = (overrides: Partial<typeof GenieState.Type> = {}): typeof GenieState.Type => ({
  phase: 'complete',
  mode: 'generate',
  cwd: '/workspace',
  files: [],
  ...overrides,
})

const createMixedResultsState = (): typeof GenieState.Type =>
  createState({
    files: [
      {
        path: '/workspace/packages/foo/package.json',
        relativePath: 'packages/foo/package.json',
        status: 'created',
        linesAdded: 42,
      },
      {
        path: '/workspace/packages/foo/tsconfig.json',
        relativePath: 'packages/foo/tsconfig.json',
        status: 'updated',
        linesAdded: 5,
        linesRemoved: 3,
      },
      {
        path: '/workspace/packages/bar/package.json',
        relativePath: 'packages/bar/package.json',
        status: 'unchanged',
      },
      {
        path: '/workspace/.github/workflows/ci.yml',
        relativePath: '.github/workflows/ci.yml',
        status: 'updated',
        linesAdded: 12,
        linesRemoved: 8,
      },
      {
        path: '/workspace/tsconfig.base.json',
        relativePath: 'tsconfig.base.json',
        status: 'unchanged',
      },
    ],
    summary: { created: 1, updated: 2, unchanged: 2, skipped: 0, failed: 0 },
  })

const createAllUnchangedState = (): typeof GenieState.Type =>
  createState({
    files: sampleFiles.map((f) => ({ ...f, status: 'unchanged' as const })),
    summary: { created: 0, updated: 0, unchanged: 5, skipped: 0, failed: 0 },
  })

const createWithErrorsState = (): typeof GenieState.Type =>
  createState({
    files: [
      {
        path: '/workspace/packages/foo/package.json',
        relativePath: 'packages/foo/package.json',
        status: 'created',
        linesAdded: 38,
      },
      {
        path: '/workspace/packages/bar/package.json',
        relativePath: 'packages/bar/package.json',
        status: 'error',
        message: 'Failed to import: SyntaxError',
      },
      {
        path: '/workspace/packages/baz/package.json',
        relativePath: 'packages/baz/package.json',
        status: 'error',
        message: 'TDZ: Cannot access catalog',
      },
      {
        path: '/workspace/tsconfig.base.json',
        relativePath: 'tsconfig.base.json',
        status: 'unchanged',
      },
    ],
    summary: { created: 1, updated: 0, unchanged: 1, skipped: 0, failed: 2 },
  })

const createDryRunState = (): typeof GenieState.Type =>
  createState({
    mode: 'dry-run',
    files: [
      {
        path: '/workspace/packages/foo/package.json',
        relativePath: 'packages/foo/package.json',
        status: 'created',
        linesAdded: 35,
      },
      {
        path: '/workspace/packages/foo/tsconfig.json',
        relativePath: 'packages/foo/tsconfig.json',
        status: 'updated',
        linesAdded: 8,
        linesRemoved: 3,
      },
      {
        path: '/workspace/packages/bar/package.json',
        relativePath: 'packages/bar/package.json',
        status: 'unchanged',
      },
    ],
    summary: { created: 1, updated: 1, unchanged: 1, skipped: 0, failed: 0 },
  })

const createCheckModeState = (): typeof GenieState.Type =>
  createState({
    mode: 'check',
    files: sampleFiles.map((f) => ({ ...f, status: 'unchanged' as const })),
    summary: { created: 0, updated: 0, unchanged: 5, skipped: 0, failed: 0 },
  })

const createCheckModeFailedState = (): typeof GenieState.Type =>
  createState({
    mode: 'check',
    files: [
      {
        path: '/workspace/packages/foo/package.json',
        relativePath: 'packages/foo/package.json',
        status: 'unchanged',
      },
      {
        path: '/workspace/packages/bar/package.json',
        relativePath: 'packages/bar/package.json',
        status: 'error',
        message: 'File is out of date',
      },
      {
        path: '/workspace/tsconfig.base.json',
        relativePath: 'tsconfig.base.json',
        status: 'unchanged',
      },
    ],
    summary: { created: 0, updated: 0, unchanged: 2, skipped: 0, failed: 1 },
  })

const createWithSkippedState = (): typeof GenieState.Type =>
  createState({
    files: [
      {
        path: '/workspace/packages/foo/package.json',
        relativePath: 'packages/foo/package.json',
        status: 'created',
      },
      {
        path: '/workspace/packages/orphan/package.json',
        relativePath: 'packages/orphan/package.json',
        status: 'skipped',
        message: 'Parent directory missing',
      },
      {
        path: '/workspace/tsconfig.base.json',
        relativePath: 'tsconfig.base.json',
        status: 'unchanged',
      },
    ],
    summary: { created: 1, updated: 0, unchanged: 1, skipped: 1, failed: 0 },
  })

/** Generate many files for viewport overflow testing */
const createManyFilesState = (phase: 'generating' | 'complete'): typeof GenieState.Type => {
  const packages = [
    'api', 'auth', 'cache', 'config', 'core', 'crypto', 'database', 'email',
    'events', 'files', 'gateway', 'http', 'i18n', 'jobs', 'kafka', 'logger',
    'metrics', 'notifications', 'oauth', 'payments', 'queue', 'redis', 'search',
    'sessions', 'storage', 'telemetry', 'uploads', 'validation', 'websocket', 'workers',
  ]

  const fileTypes = ['package.json', 'tsconfig.json', 'index.ts']

  const files: Array<typeof GenieState.Type['files'][number]> = []

  // Generate files for each package
  for (const pkg of packages) {
    for (const fileType of fileTypes) {
      const path = `/workspace/packages/${pkg}/${fileType}`
      const relativePath = `packages/${pkg}/${fileType}`

      // Assign varied statuses to make it interesting
      let status: typeof GenieState.Type['files'][number]['status']
      let message: string | undefined
      let linesAdded: number | undefined
      let linesRemoved: number | undefined

      if (pkg === 'auth' && fileType === 'package.json') {
        status = 'error'
        message = 'Failed to import: SyntaxError in source file'
      } else if (pkg === 'payments' && fileType === 'tsconfig.json') {
        status = 'error'
        message = 'TDZ: Cannot access catalog before initialization'
      } else if (pkg === 'gateway' && fileType === 'index.ts') {
        status = phase === 'generating' ? 'active' : 'updated'
        linesAdded = 45
        linesRemoved = 12
      } else if (pkg === 'websocket' && fileType === 'package.json') {
        status = phase === 'generating' ? 'active' : 'created'
        linesAdded = 38
      } else if (pkg === 'redis' && fileType === 'index.ts') {
        status = phase === 'generating' ? 'active' : 'updated'
        linesAdded = 23
        linesRemoved = 5
      } else if (['api', 'core', 'http'].includes(pkg)) {
        status = 'created'
        linesAdded = Math.floor(Math.random() * 50) + 10
      } else if (['cache', 'config', 'logger'].includes(pkg)) {
        status = 'updated'
        linesAdded = Math.floor(Math.random() * 20) + 5
        linesRemoved = Math.floor(Math.random() * 10) + 1
      } else if (pkg === 'i18n') {
        status = 'skipped'
        message = 'Parent directory missing'
      } else if (phase === 'generating' && ['telemetry', 'workers', 'validation'].includes(pkg)) {
        status = 'pending'
      } else {
        status = 'unchanged'
      }

      files.push({ path, relativePath, status, message, linesAdded, linesRemoved })
    }
  }

  // Calculate summary
  const summary = {
    created: files.filter(f => f.status === 'created').length,
    updated: files.filter(f => f.status === 'updated').length,
    unchanged: files.filter(f => f.status === 'unchanged').length,
    skipped: files.filter(f => f.status === 'skipped').length,
    failed: files.filter(f => f.status === 'error').length,
  }

  return createState({
    phase,
    files,
    summary: phase === 'complete' ? summary : undefined,
  })
}

// =============================================================================
// Timeline for Animated Demo
// =============================================================================

const genieTimeline: Array<{ at: number; action: typeof GenieAction.Type }> = [
  // Files discovered
  {
    at: 0,
    action: {
      _tag: 'FilesDiscovered',
      files: sampleFiles,
    },
  },

  // First file - start
  { at: 100, action: { _tag: 'FileStarted', path: sampleFiles[0]!.path } },
  // First file - complete (created, all new lines)
  {
    at: 400,
    action: {
      _tag: 'FileCompleted',
      path: sampleFiles[0]!.path,
      status: 'created',
      linesAdded: 42,
    },
  },

  // Second file - start
  { at: 450, action: { _tag: 'FileStarted', path: sampleFiles[1]!.path } },
  // Second file - complete (updated with diff)
  {
    at: 700,
    action: {
      _tag: 'FileCompleted',
      path: sampleFiles[1]!.path,
      status: 'updated',
      linesAdded: 5,
      linesRemoved: 3,
    },
  },

  // Third file - start
  { at: 750, action: { _tag: 'FileStarted', path: sampleFiles[2]!.path } },
  // Third file - complete (unchanged)
  { at: 950, action: { _tag: 'FileCompleted', path: sampleFiles[2]!.path, status: 'unchanged' } },

  // Fourth file - start
  { at: 1000, action: { _tag: 'FileStarted', path: sampleFiles[3]!.path } },
  // Fourth file - complete (updated with diff)
  {
    at: 1300,
    action: {
      _tag: 'FileCompleted',
      path: sampleFiles[3]!.path,
      status: 'updated',
      linesAdded: 12,
      linesRemoved: 8,
    },
  },

  // Fifth file - start
  { at: 1350, action: { _tag: 'FileStarted', path: sampleFiles[4]!.path } },
  // Fifth file - complete (unchanged)
  { at: 1500, action: { _tag: 'FileCompleted', path: sampleFiles[4]!.path, status: 'unchanged' } },

  // Complete
  {
    at: 1700,
    action: {
      _tag: 'Complete',
      summary: { created: 1, updated: 2, unchanged: 2, skipped: 0, failed: 0 },
    },
  },
]

// =============================================================================
// Story Configuration
// =============================================================================

const ALL_TABS: OutputTab[] = ['tty', 'ci', 'ci-plain', 'log', 'json', 'ndjson']

export default {
  title: 'CLI/Genie Output',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
Genie command output for code generation.

**Demonstrates:**
- File generation status (created, updated, unchanged, skipped, error)
- Dry run mode
- Check mode (CI)
- TDZ error handling
- Progress tracking with spinners

**Output modes:** TTY, CI, CI Plain, Log, JSON, NDJSON
        `,
      },
    },
  },
} satisfies Meta

type Story = StoryObj<{
  autoRun: boolean
  playbackSpeed: number
  height: number
}>

// =============================================================================
// Stories
// =============================================================================

/** Animated generation simulation */
export const Demo: Story = {
  args: { autoRun: true, playbackSpeed: 1, height: 350 },
  argTypes: {
    autoRun: { description: 'Auto-start timeline', control: { type: 'boolean' } },
    playbackSpeed: {
      description: 'Playback speed',
      control: { type: 'range', min: 0.5, max: 3, step: 0.5 },
    },
    height: {
      description: 'Terminal height',
      control: { type: 'range', min: 200, max: 600, step: 50 },
    },
  },
  render: (args) => (
    <TuiStoryPreview
      View={GenieView}
      stateSchema={GenieState}
      actionSchema={GenieAction}
      reducer={genieReducer}
      initialState={createState({ phase: 'discovering' })}
      timeline={genieTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Mixed results - created, updated, unchanged */
export const MixedResults: Story = {
  args: { height: 350 },
  render: (args) => (
    <TuiStoryPreview
      View={GenieView}
      stateSchema={GenieState}
      actionSchema={GenieAction}
      reducer={genieReducer}
      initialState={createMixedResultsState()}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

/** All files unchanged */
export const AllUnchanged: Story = {
  args: { height: 350 },
  render: (args) => (
    <TuiStoryPreview
      View={GenieView}
      stateSchema={GenieState}
      actionSchema={GenieAction}
      reducer={genieReducer}
      initialState={createAllUnchangedState()}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

/** With errors (including TDZ cascade) */
export const WithErrors: Story = {
  args: { height: 350 },
  render: (args) => (
    <TuiStoryPreview
      View={GenieView}
      stateSchema={GenieState}
      actionSchema={GenieAction}
      reducer={genieReducer}
      initialState={createWithErrorsState()}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

/** Dry run mode */
export const DryRun: Story = {
  args: { height: 350 },
  render: (args) => (
    <TuiStoryPreview
      View={GenieView}
      stateSchema={GenieState}
      actionSchema={GenieAction}
      reducer={genieReducer}
      initialState={createDryRunState()}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

/** Check mode - all up to date */
export const CheckModeSuccess: Story = {
  args: { height: 350 },
  render: (args) => (
    <TuiStoryPreview
      View={GenieView}
      stateSchema={GenieState}
      actionSchema={GenieAction}
      reducer={genieReducer}
      initialState={createCheckModeState()}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

/** Check mode - files out of date */
export const CheckModeFailed: Story = {
  args: { height: 350 },
  render: (args) => (
    <TuiStoryPreview
      View={GenieView}
      stateSchema={GenieState}
      actionSchema={GenieAction}
      reducer={genieReducer}
      initialState={createCheckModeFailedState()}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

/** With skipped files */
export const WithSkipped: Story = {
  args: { height: 350 },
  render: (args) => (
    <TuiStoryPreview
      View={GenieView}
      stateSchema={GenieState}
      actionSchema={GenieAction}
      reducer={genieReducer}
      initialState={createWithSkippedState()}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

/** Many files - generating phase (viewport overflow demo) */
export const ManyFilesGenerating: Story = {
  args: { height: 300 },
  argTypes: {
    height: {
      description: 'Terminal height (reduce to see truncation)',
      control: { type: 'range', min: 150, max: 600, step: 25 },
    },
  },
  render: (args) => (
    <TuiStoryPreview
      View={GenieView}
      stateSchema={GenieState}
      actionSchema={GenieAction}
      reducer={genieReducer}
      initialState={createManyFilesState('generating')}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

/** Many files - complete phase (viewport overflow demo) */
export const ManyFilesComplete: Story = {
  args: { height: 300 },
  argTypes: {
    height: {
      description: 'Terminal height (reduce to see truncation)',
      control: { type: 'range', min: 150, max: 600, step: 25 },
    },
  },
  render: (args) => (
    <TuiStoryPreview
      View={GenieView}
      stateSchema={GenieState}
      actionSchema={GenieAction}
      reducer={genieReducer}
      initialState={createManyFilesState('complete')}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}
