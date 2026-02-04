/**
 * Complete state stories for ExecOutput - various completion scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import type { ExecStateType } from '../mod.ts'
import { ExecApp } from '../mod.ts'
import { ExecView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  verbose: boolean
  mode: 'parallel' | 'sequential'
  member: string
}

export default {
  component: ExecView,
  title: 'CLI/Exec/Complete',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    ...defaultStoryArgs,
    verbose: false,
    mode: 'parallel',
    member: '',
  },
  argTypes: {
    ...commonArgTypes,
    verbose: {
      description: '--verbose flag',
      control: { type: 'boolean' },
    },
    mode: {
      description: '--mode flag',
      control: { type: 'select' },
      options: ['parallel', 'sequential'],
    },
    member: {
      description: '--member / -m flag (filter to single member, empty = all)',
      control: { type: 'text' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// Helper to filter members based on --member flag
const filterMembers = <T extends { name: string }>(_: {
  members: readonly T[]
  memberFilter: string
}): T[] => {
  if (!_.memberFilter) return [..._.members]
  return _.members.filter((m) => m.name === _.memberFilter)
}

// Helper to create complete state with verbose, mode, and member filter override
const withOverrides = (_: {
  state: ExecStateType
  verbose: boolean
  mode: 'parallel' | 'sequential'
  member: string
}): ExecStateType => {
  if (_.state._tag !== 'Complete') return _.state
  const filteredMembers = filterMembers({ members: _.state.members, memberFilter: _.member })
  return {
    ..._.state,
    verbose: _.verbose,
    mode: _.mode,
    members: filteredMembers,
    hasErrors: filteredMembers.some((m) => m.status === 'error'),
  }
}

const successMembers = [
  { name: 'effect', status: 'success' as const, exitCode: 0, stdout: 'v3.0.0' },
  { name: 'effect-utils', status: 'success' as const, exitCode: 0, stdout: 'v1.2.3' },
  { name: 'livestore', status: 'success' as const, exitCode: 0, stdout: 'v0.5.0' },
]

const mixedMembers = [
  { name: 'effect', status: 'success' as const, exitCode: 0, stdout: 'v3.0.0' },
  { name: 'effect-utils', status: 'success' as const, exitCode: 0, stdout: 'v1.2.3' },
  {
    name: 'livestore',
    status: 'error' as const,
    exitCode: 1,
    stderr: 'Command failed: npm version',
  },
]

const skippedMembers = [
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
]

const allErrorMembers = [
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
]

const verboseMembers = [
  { name: 'effect', status: 'success' as const, exitCode: 0, stdout: 'v3.0.0' },
  { name: 'effect-utils', status: 'success' as const, exitCode: 0, stdout: 'v1.2.3' },
]

/** All commands completed successfully */
export const CompleteSuccess: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        command: 'npm version',
        mode: args.mode,
        verbose: args.verbose,
        members: filterMembers({ members: successMembers, memberFilter: args.member }),
      }),
      [args.mode, args.verbose, args.member],
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
                member: args.member,
              })
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
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
        members: filterMembers({ members: mixedMembers, memberFilter: args.member }),
      }),
      [args.mode, args.verbose, args.member],
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
                member: args.member,
              })
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
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
        members: filterMembers({ members: skippedMembers, memberFilter: args.member }),
      }),
      [args.mode, args.verbose, args.member],
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
                member: args.member,
              })
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
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
        members: filterMembers({ members: allErrorMembers, memberFilter: args.member }),
      }),
      [args.mode, args.verbose, args.member],
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
                member: args.member,
              })
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
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
        members: filterMembers({ members: verboseMembers, memberFilter: args.member }),
      }),
      [args.mode, args.verbose, args.member],
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
                member: args.member,
              })
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}
