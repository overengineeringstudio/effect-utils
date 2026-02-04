/**
 * Running state stories for ExecOutput.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

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
  member: string
}

export default {
  component: ExecView,
  title: 'CLI/Exec/Running',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    height: 400,
    interactive: false,
    playbackSpeed: 1,
    verbose: true,
    mode: 'parallel',
    member: '',
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

const parallelMembers = [
  { name: 'effect', status: 'success' as const, exitCode: 0, stdout: 'v3.0.0' },
  { name: 'effect-utils', status: 'success' as const, exitCode: 0, stdout: 'v1.2.3' },
  { name: 'livestore', status: 'success' as const, exitCode: 0, stdout: 'v0.5.0' },
]

const sequentialMembers = [
  { name: 'effect', status: 'success' as const, exitCode: 0, stdout: 'On branch main' },
  {
    name: 'effect-utils',
    status: 'success' as const,
    exitCode: 0,
    stdout: 'On branch feature',
  },
]

export const RunningVerboseParallel: Story = {
  args: {
    verbose: true,
    mode: 'parallel',
  },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        command: 'npm version',
        mode: args.mode,
        verbose: args.verbose,
        members: filterMembers({ members: parallelMembers, memberFilter: args.member }),
      }),
      [args.mode, args.verbose, args.member],
    )
    return (
      <TuiStoryPreview
        View={ExecView}
        app={ExecApp}
        initialState={fixtures.createRunningState({ verbose: args.verbose, mode: args.mode })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

export const RunningVerboseSequential: Story = {
  args: {
    verbose: true,
    mode: 'sequential',
  },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        command: 'git status',
        mode: args.mode,
        verbose: args.verbose,
        members: filterMembers({ members: sequentialMembers, memberFilter: args.member }),
      }),
      [args.mode, args.verbose, args.member],
    )
    return (
      <TuiStoryPreview
        View={ExecView}
        app={ExecApp}
        initialState={fixtures.createRunningState({ verbose: args.verbose, mode: args.mode })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}
