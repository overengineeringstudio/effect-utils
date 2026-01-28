/**
 * Storybook stories for StoreAdd components.
 */

import type { StoryObj } from '@storybook/react'
import { createCliMeta } from '@overeng/tui-react/storybook'
import { forceColorLevel } from '@overeng/cli-ui'
import {
  StoreAddError,
  StoreAddProgress,
  StoreAddSuccess,
  type StoreAddErrorProps,
  type StoreAddProgressProps,
  type StoreAddSuccessProps,
} from './StoreOutput.tsx'

forceColorLevel('truecolor')

// =============================================================================
// Example Data
// =============================================================================

const exampleAddSuccess: StoreAddSuccessProps = {
  source: 'effect-ts/effect',
  ref: 'main',
  commit: 'abc1234567890',
  path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/main',
  alreadyExists: false,
}

const exampleAddSuccessExisting: StoreAddSuccessProps = {
  source: 'effect-ts/effect',
  ref: 'main',
  commit: 'abc1234567890',
  path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/main',
  alreadyExists: true,
}

// =============================================================================
// Error Stories
// =============================================================================

const errorMeta = createCliMeta<StoreAddErrorProps>(StoreAddError, {
  title: 'CLI/Store/Add/Error',
  description: 'Error output for the `mr store add` command when inputs are invalid.',
  defaultArgs: {
    type: 'invalid_source',
  },
  argTypes: {
    type: {
      description: 'Error type',
      control: { type: 'select' },
      options: ['invalid_source', 'local_path', 'no_url'],
      table: { category: 'Error' },
    },
    source: {
      description: 'Source string that caused the error (for invalid_source)',
      control: { type: 'text' },
      table: { category: 'Error' },
    },
  },
})

export default errorMeta

type ErrorStory = StoryObj<typeof errorMeta>

export const InvalidSource: ErrorStory = {
  args: {
    type: 'invalid_source',
    source: 'not-a-valid-source',
  },
}

export const LocalPath: ErrorStory = {
  args: {
    type: 'local_path',
  },
}

export const NoUrl: ErrorStory = {
  args: {
    type: 'no_url',
  },
}

// =============================================================================
// Progress Stories
// =============================================================================

export const progressMeta = createCliMeta<StoreAddProgressProps>(StoreAddProgress, {
  title: 'CLI/Store/Add/Progress',
  description: 'Progress output for the `mr store add` command during clone/worktree creation.',
  defaultArgs: {
    type: 'cloning',
  },
  argTypes: {
    type: {
      description: 'Progress step type',
      control: { type: 'select' },
      options: ['cloning', 'creating_worktree'],
      table: { category: 'Progress' },
    },
  },
})

type ProgressStory = StoryObj<typeof progressMeta>

export const Cloning: ProgressStory = {
  args: {
    type: 'cloning',
    source: 'effect-ts/effect',
  },
}

export const CreatingWorktree: ProgressStory = {
  args: {
    type: 'creating_worktree',
    ref: 'main',
  },
}

// =============================================================================
// Success Stories
// =============================================================================

export const successMeta = createCliMeta<StoreAddSuccessProps>(StoreAddSuccess, {
  title: 'CLI/Store/Add/Success',
  description: 'Success output for the `mr store add` command after successful add.',
  defaultArgs: exampleAddSuccess,
  argTypes: {
    alreadyExists: {
      description: 'Whether the repository already existed in the store',
      control: { type: 'boolean' },
      table: { category: 'Status' },
    },
  },
})

type SuccessStory = StoryObj<typeof successMeta>

export const SuccessNew: SuccessStory = {
  args: exampleAddSuccess,
}

export const SuccessExisting: SuccessStory = {
  args: exampleAddSuccessExisting,
}

export const SuccessWithRef: SuccessStory = {
  args: {
    source: 'effect-ts/effect#feat/new-feature',
    ref: 'feat/new-feature',
    commit: 'def456789012',
    path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/feat/new-feature',
    alreadyExists: false,
  },
}

export const SuccessNoCommit: SuccessStory = {
  args: {
    source: 'effect-ts/effect',
    ref: 'v3.0.0',
    commit: undefined,
    path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/v3.0.0',
    alreadyExists: false,
  },
}
