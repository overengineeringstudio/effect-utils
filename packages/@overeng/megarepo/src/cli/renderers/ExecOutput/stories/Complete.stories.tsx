/**
 * Complete state stories for ExecOutput - various completion scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import type { ExecStateType } from '../mod.ts'
import { ExecApp } from '../mod.ts'
import { ExecView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

const ALL_TABS: OutputTab[] = [
  'tty',
  'alt-screen',
  'ci',
  'ci-plain',
  'pipe',
  'log',
  'json',
  'ndjson',
]

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  verbose: boolean
  mode: 'parallel' | 'sequential'
}

export default {
  component: ExecView,
  title: 'CLI/Exec/Complete',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    height: 400,
    interactive: false,
    playbackSpeed: 1,
    verbose: false,
    mode: 'parallel',
  },
  argTypes: {
    height: {
      description: 'Terminal height in pixels',
      control: { type: 'range', min: 200, max: 600, step: 50 },
    },
    interactive: {
      description: 'Enable animated timeline playback',
      control: { type: 'boolean' },
    },
    playbackSpeed: {
      description: 'Playback speed multiplier (when interactive)',
      control: { type: 'range', min: 0.5, max: 3, step: 0.5 },
      if: { arg: 'interactive' },
    },
    verbose: {
      description: '--verbose flag',
      control: { type: 'boolean' },
    },
    mode: {
      description: '--mode flag',
      control: { type: 'select' },
      options: ['parallel', 'sequential'],
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// Helper to create complete state with verbose and mode override
const withOverrides = (_: {
  state: ExecStateType
  verbose: boolean
  mode: 'parallel' | 'sequential'
}): ExecStateType => {
  if (_.state._tag !== 'Complete') return _.state
  return { ..._.state, verbose: _.verbose, mode: _.mode }
}

/** All commands completed successfully */
export const CompleteSuccess: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        command: 'npm version',
        mode: args.mode,
        verbose: args.verbose,
        members: [
          { name: 'effect', status: 'success' as const, exitCode: 0, stdout: 'v3.0.0' },
          { name: 'effect-utils', status: 'success' as const, exitCode: 0, stdout: 'v1.2.3' },
          { name: 'livestore', status: 'success' as const, exitCode: 0, stdout: 'v0.5.0' },
        ],
      }),
      [args.mode, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={ExecView}
        app={ExecApp}
        initialState={
          args.interactive
            ? fixtures.createRunningState({ verbose: args.verbose, mode: args.mode })
            : withOverrides({
                state: fixtures.completeSuccessState,
                verbose: args.verbose,
                mode: args.mode,
              })
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Mixed results - some success, some errors */
export const CompleteMixed: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        command: 'npm version',
        mode: args.mode,
        verbose: args.verbose,
        members: [
          { name: 'effect', status: 'success' as const, exitCode: 0, stdout: 'v3.0.0' },
          { name: 'effect-utils', status: 'success' as const, exitCode: 0, stdout: 'v1.2.3' },
          {
            name: 'livestore',
            status: 'error' as const,
            exitCode: 1,
            stderr: 'Command failed: npm version',
          },
        ],
      }),
      [args.mode, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={ExecView}
        app={ExecApp}
        initialState={
          args.interactive
            ? fixtures.createRunningState({ verbose: args.verbose, mode: args.mode })
            : withOverrides({
                state: fixtures.completeMixedState,
                verbose: args.verbose,
                mode: args.mode,
              })
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Some members skipped */
export const CompleteWithSkipped: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        command: 'npm install',
        mode: args.mode,
        verbose: args.verbose,
        members: [
          {
            name: 'effect',
            status: 'success' as const,
            exitCode: 0,
            stdout: 'added 125 packages in 2.3s',
          },
          { name: 'effect-utils', status: 'skipped' as const, stderr: 'Member not synced' },
          {
            name: 'livestore',
            status: 'success' as const,
            exitCode: 0,
            stdout: 'added 45 packages in 1.1s',
          },
        ],
      }),
      [args.mode, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={ExecView}
        app={ExecApp}
        initialState={
          args.interactive
            ? fixtures.createRunningState({ verbose: args.verbose, mode: args.mode })
            : withOverrides({
                state: fixtures.completeWithSkippedState,
                verbose: args.verbose,
                mode: args.mode,
              })
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** All commands failed */
export const CompleteAllErrors: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        command: 'foo',
        mode: args.mode,
        verbose: args.verbose,
        members: [
          {
            name: 'effect',
            status: 'error' as const,
            exitCode: 1,
            stderr: 'Command not found: foo',
          },
          {
            name: 'effect-utils',
            status: 'error' as const,
            exitCode: 1,
            stderr: 'Permission denied',
          },
          {
            name: 'livestore',
            status: 'error' as const,
            exitCode: 127,
            stderr: 'sh: command not found',
          },
        ],
      }),
      [args.mode, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={ExecView}
        app={ExecApp}
        initialState={
          args.interactive
            ? fixtures.createRunningState({ verbose: args.verbose, mode: args.mode })
            : withOverrides({
                state: fixtures.completeAllErrorsState,
                verbose: args.verbose,
                mode: args.mode,
              })
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Verbose output showing all details */
export const CompleteVerbose: Story = {
  args: {
    verbose: true,
  },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        command: 'npm version',
        mode: args.mode,
        verbose: args.verbose,
        members: [
          { name: 'effect', status: 'success' as const, exitCode: 0, stdout: 'v3.0.0' },
          { name: 'effect-utils', status: 'success' as const, exitCode: 0, stdout: 'v1.2.3' },
        ],
      }),
      [args.mode, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={ExecView}
        app={ExecApp}
        initialState={
          args.interactive
            ? fixtures.createRunningState({ verbose: args.verbose, mode: args.mode })
            : withOverrides({
                state: fixtures.completeVerboseState,
                verbose: args.verbose,
                mode: args.mode,
              })
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}
