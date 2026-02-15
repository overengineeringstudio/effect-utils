/**
 * Running state stories for ExecOutput.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

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
  title: 'CLI/Exec/Running',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    ...defaultStoryArgs,
    verbose: true,
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
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
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
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}
