/**
 * Error/issue stories for GenieOutput.
 *
 * Demonstrates various error scenarios including:
 * - File-level errors (SyntaxError, TDZ cascade)
 * - Check mode failures (out-of-date files)
 * - Global errors (config not found)
 * - Mixed error types (errors + skipped + success)
 * - Skipped files (parent directory missing)
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import { GenieApp } from '../../app.ts'
import type { GenieMode } from '../../schema.ts'
import { GenieView } from '../../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  mode: GenieMode
}

export default {
  component: GenieView,
  title: 'CLI/Genie/Errors',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    ...defaultStoryArgs,
    mode: 'generate',
  },
  argTypes: {
    ...commonArgTypes,
    mode: {
      description: 'Operation mode',
      control: { type: 'select' },
      options: ['generate', 'check', 'dry-run'] satisfies GenieMode[],
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** File-level errors (SyntaxError, TDZ cascade) */
export const WithErrors: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () =>
        fixtures.createState({
          mode: args.mode,
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
              message: fixtures.errorMessages.syntaxError,
            },
            {
              path: '/workspace/packages/baz/package.json',
              relativePath: 'packages/baz/package.json',
              status: 'error',
              message: fixtures.errorMessages.tdzCascade,
            },
            {
              path: '/workspace/tsconfig.base.json',
              relativePath: 'tsconfig.base.json',
              status: 'unchanged',
            },
          ],
          summary: { created: 1, updated: 0, unchanged: 1, skipped: 0, failed: 2 },
        }),
      [args.mode],
    )

    const timeline = useMemo(
      () =>
        fixtures.createTimeline({
          files: [
            {
              path: '/workspace/packages/foo/package.json',
              relativePath: 'packages/foo/package.json',
            },
            {
              path: '/workspace/packages/bar/package.json',
              relativePath: 'packages/bar/package.json',
            },
            {
              path: '/workspace/packages/baz/package.json',
              relativePath: 'packages/baz/package.json',
            },
            { path: '/workspace/tsconfig.base.json', relativePath: 'tsconfig.base.json' },
          ],
          results: [
            {
              path: '/workspace/packages/foo/package.json',
              status: 'created',
              linesAdded: 38,
            },
            {
              path: '/workspace/packages/bar/package.json',
              status: 'error',
              message: fixtures.errorMessages.syntaxError,
            },
            {
              path: '/workspace/packages/baz/package.json',
              status: 'error',
              message: fixtures.errorMessages.tdzCascade,
            },
            { path: '/workspace/tsconfig.base.json', status: 'unchanged' },
          ],
          mode: args.mode,
          stepDuration: 500,
        }),
      [args.mode],
    )

    return (
      <TuiStoryPreview
        View={GenieView}
        app={GenieApp}
        initialState={
          args.interactive
            ? fixtures.createState({ phase: 'discovering', mode: args.mode })
            : stateConfig
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline } : {})}
      />
    )
  },
}

/** Check mode - some files out of date (failure) */
export const CheckModeFailed: Story = {
  args: {
    mode: 'check',
  },
  render: (args) => {
    const stateConfig = useMemo(
      () =>
        fixtures.createState({
          mode: 'check', // Always check mode for this story
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
              message: fixtures.errorMessages.fileOutOfDate,
            },
            {
              path: '/workspace/packages/baz/tsconfig.json',
              relativePath: 'packages/baz/tsconfig.json',
              status: 'error',
              message: fixtures.errorMessages.fileOutOfDate,
            },
            {
              path: '/workspace/tsconfig.base.json',
              relativePath: 'tsconfig.base.json',
              status: 'unchanged',
            },
          ],
          summary: { created: 0, updated: 0, unchanged: 2, skipped: 0, failed: 2 },
        }),
      [],
    )

    const timeline = useMemo(
      () =>
        fixtures.createTimeline({
          files: [
            {
              path: '/workspace/packages/foo/package.json',
              relativePath: 'packages/foo/package.json',
            },
            {
              path: '/workspace/packages/bar/package.json',
              relativePath: 'packages/bar/package.json',
            },
            {
              path: '/workspace/packages/baz/tsconfig.json',
              relativePath: 'packages/baz/tsconfig.json',
            },
            { path: '/workspace/tsconfig.base.json', relativePath: 'tsconfig.base.json' },
          ],
          results: [
            { path: '/workspace/packages/foo/package.json', status: 'unchanged' },
            {
              path: '/workspace/packages/bar/package.json',
              status: 'error',
              message: fixtures.errorMessages.fileOutOfDate,
            },
            {
              path: '/workspace/packages/baz/tsconfig.json',
              status: 'error',
              message: fixtures.errorMessages.fileOutOfDate,
            },
            { path: '/workspace/tsconfig.base.json', status: 'unchanged' },
          ],
          mode: 'check',
          stepDuration: 400,
        }),
      [],
    )

    return (
      <TuiStoryPreview
        View={GenieView}
        app={GenieApp}
        initialState={
          args.interactive
            ? fixtures.createState({ phase: 'discovering', mode: 'check' })
            : stateConfig
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline } : {})}
      />
    )
  },
}

/** Global error phase (config not found, etc.) */
export const GlobalError: Story = {
  // GlobalError uses phase='error' which is terminal - interactive doesn't make sense
  args: {
    interactive: false,
  },
  argTypes: {
    interactive: {
      control: false, // Disable interactive for global errors
    },
    playbackSpeed: {
      control: false,
    },
  },
  render: (args) => {
    const stateConfig = useMemo(
      () =>
        fixtures.createState({
          phase: 'error',
          mode: args.mode,
          error: 'Failed to load genie configuration: genie.config.ts not found in workspace root',
          files: [],
        }),
      [args.mode],
    )

    return (
      <TuiStoryPreview
        View={GenieView}
        app={GenieApp}
        initialState={stateConfig}
        height={args.height}
        autoRun={false}
        tabs={ALL_OUTPUT_TABS}
      />
    )
  },
}

/** Mixed error types - combination of errors + skipped + success in same run */
export const MixedErrorTypes: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () =>
        fixtures.createState({
          mode: args.mode,
          files: [
            {
              path: '/workspace/packages/api/package.json',
              relativePath: 'packages/api/package.json',
              status: 'created',
              linesAdded: 45,
            },
            {
              path: '/workspace/packages/core/package.json',
              relativePath: 'packages/core/package.json',
              status: 'updated',
              linesAdded: 12,
              linesRemoved: 5,
            },
            {
              path: '/workspace/packages/auth/package.json',
              relativePath: 'packages/auth/package.json',
              status: 'error',
              message: fixtures.errorMessages.syntaxError,
            },
            {
              path: '/workspace/packages/payments/tsconfig.json',
              relativePath: 'packages/payments/tsconfig.json',
              status: 'error',
              message: fixtures.errorMessages.tdzCascade,
            },
            {
              path: '/workspace/packages/orphan/package.json',
              relativePath: 'packages/orphan/package.json',
              status: 'skipped',
              message: fixtures.errorMessages.parentMissing,
            },
            {
              path: '/workspace/packages/config/package.json',
              relativePath: 'packages/config/package.json',
              status: 'unchanged',
            },
            {
              path: '/workspace/tsconfig.base.json',
              relativePath: 'tsconfig.base.json',
              status: 'unchanged',
            },
          ],
          summary: { created: 1, updated: 1, unchanged: 2, skipped: 1, failed: 2 },
        }),
      [args.mode],
    )

    const timeline = useMemo(
      () =>
        fixtures.createTimeline({
          files: [
            {
              path: '/workspace/packages/api/package.json',
              relativePath: 'packages/api/package.json',
            },
            {
              path: '/workspace/packages/core/package.json',
              relativePath: 'packages/core/package.json',
            },
            {
              path: '/workspace/packages/auth/package.json',
              relativePath: 'packages/auth/package.json',
            },
            {
              path: '/workspace/packages/payments/tsconfig.json',
              relativePath: 'packages/payments/tsconfig.json',
            },
            {
              path: '/workspace/packages/orphan/package.json',
              relativePath: 'packages/orphan/package.json',
            },
            {
              path: '/workspace/packages/config/package.json',
              relativePath: 'packages/config/package.json',
            },
            { path: '/workspace/tsconfig.base.json', relativePath: 'tsconfig.base.json' },
          ],
          results: [
            { path: '/workspace/packages/api/package.json', status: 'created', linesAdded: 45 },
            {
              path: '/workspace/packages/core/package.json',
              status: 'updated',
              linesAdded: 12,
              linesRemoved: 5,
            },
            {
              path: '/workspace/packages/auth/package.json',
              status: 'error',
              message: fixtures.errorMessages.syntaxError,
            },
            {
              path: '/workspace/packages/payments/tsconfig.json',
              status: 'error',
              message: fixtures.errorMessages.tdzCascade,
            },
            {
              path: '/workspace/packages/orphan/package.json',
              status: 'skipped',
              message: fixtures.errorMessages.parentMissing,
            },
            { path: '/workspace/packages/config/package.json', status: 'unchanged' },
            { path: '/workspace/tsconfig.base.json', status: 'unchanged' },
          ],
          mode: args.mode,
          stepDuration: 400,
        }),
      [args.mode],
    )

    return (
      <TuiStoryPreview
        View={GenieView}
        app={GenieApp}
        initialState={
          args.interactive
            ? fixtures.createState({ phase: 'discovering', mode: args.mode })
            : stateConfig
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline } : {})}
      />
    )
  },
}

/** Validation failed (tsconfig references, peer deps, etc.) */
export const ValidationFailed: Story = {
  args: {
    mode: 'check',
    interactive: false,
  },
  argTypes: {
    interactive: {
      control: false,
    },
    playbackSpeed: {
      control: false,
    },
  },
  render: (args) => {
    const stateConfig = useMemo(
      () => fixtures.createValidationFailedState({ mode: args.mode }),
      [args.mode],
    )

    return (
      <TuiStoryPreview
        View={GenieView}
        app={GenieApp}
        initialState={stateConfig}
        height={args.height}
        autoRun={false}
        tabs={ALL_OUTPUT_TABS}
      />
    )
  },
}

/** Validation failed during generation (Issue #153) */
export const ValidationFailedDuringGeneration: Story = {
  args: {
    mode: 'generate',
    interactive: false,
  },
  argTypes: {
    interactive: {
      control: false,
    },
    playbackSpeed: {
      control: false,
    },
  },
  render: (args) => {
    const stateConfig = useMemo(
      () => fixtures.createValidationFailedState({ mode: args.mode }),
      [args.mode],
    )

    return (
      <TuiStoryPreview
        View={GenieView}
        app={GenieApp}
        initialState={stateConfig}
        height={args.height}
        autoRun={false}
        tabs={ALL_OUTPUT_TABS}
      />
    )
  },
}

/** Files skipped (parent directory missing, etc.) */
export const WithSkipped: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () =>
        fixtures.createState({
          mode: args.mode,
          files: [
            {
              path: '/workspace/packages/foo/package.json',
              relativePath: 'packages/foo/package.json',
              status: 'created',
              linesAdded: 32,
            },
            {
              path: '/workspace/packages/orphan/package.json',
              relativePath: 'packages/orphan/package.json',
              status: 'skipped',
              message: fixtures.errorMessages.parentMissing,
            },
            {
              path: '/workspace/packages/legacy/tsconfig.json',
              relativePath: 'packages/legacy/tsconfig.json',
              status: 'skipped',
              message: fixtures.errorMessages.permissionDenied,
            },
            {
              path: '/workspace/packages/remote/package.json',
              relativePath: 'packages/remote/package.json',
              status: 'skipped',
              message: fixtures.errorMessages.networkTimeout,
            },
            {
              path: '/workspace/tsconfig.base.json',
              relativePath: 'tsconfig.base.json',
              status: 'unchanged',
            },
          ],
          summary: { created: 1, updated: 0, unchanged: 1, skipped: 3, failed: 0 },
        }),
      [args.mode],
    )

    const timeline = useMemo(
      () =>
        fixtures.createTimeline({
          files: [
            {
              path: '/workspace/packages/foo/package.json',
              relativePath: 'packages/foo/package.json',
            },
            {
              path: '/workspace/packages/orphan/package.json',
              relativePath: 'packages/orphan/package.json',
            },
            {
              path: '/workspace/packages/legacy/tsconfig.json',
              relativePath: 'packages/legacy/tsconfig.json',
            },
            {
              path: '/workspace/packages/remote/package.json',
              relativePath: 'packages/remote/package.json',
            },
            { path: '/workspace/tsconfig.base.json', relativePath: 'tsconfig.base.json' },
          ],
          results: [
            { path: '/workspace/packages/foo/package.json', status: 'created', linesAdded: 32 },
            {
              path: '/workspace/packages/orphan/package.json',
              status: 'skipped',
              message: fixtures.errorMessages.parentMissing,
            },
            {
              path: '/workspace/packages/legacy/tsconfig.json',
              status: 'skipped',
              message: fixtures.errorMessages.permissionDenied,
            },
            {
              path: '/workspace/packages/remote/package.json',
              status: 'skipped',
              message: fixtures.errorMessages.networkTimeout,
            },
            { path: '/workspace/tsconfig.base.json', status: 'unchanged' },
          ],
          mode: args.mode,
          stepDuration: 450,
        }),
      [args.mode],
    )

    return (
      <TuiStoryPreview
        View={GenieView}
        app={GenieApp}
        initialState={
          args.interactive
            ? fixtures.createState({ phase: 'discovering', mode: args.mode })
            : stateConfig
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline } : {})}
      />
    )
  },
}
