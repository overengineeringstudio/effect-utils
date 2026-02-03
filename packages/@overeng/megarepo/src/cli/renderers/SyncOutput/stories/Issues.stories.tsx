/**
 * Issue/error/skipped stories for SyncOutput.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import type { MemberSyncResult } from '../../../../lib/sync/schema.ts'
import { SyncApp } from '../mod.ts'
import { SyncView } from '../view.tsx'
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
  dryRun: boolean
}

export default {
  component: SyncView,
  title: 'CLI/Sync/Issues',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    height: 400,
    interactive: false,
    playbackSpeed: 1,
    dryRun: false,
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
    dryRun: {
      description: '--dry-run flag: show what would happen without making changes',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Some members failed with errors */
export const WithErrors: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: { dryRun: args.dryRun, frozen: false, pull: false, all: false },
        results: fixtures.exampleSyncResultsWithErrors,
        members: fixtures.exampleSyncResultsWithErrors.map((r) => r.name),
      }),
      [args.dryRun],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(args.interactive ? { phase: 'idle' } : stateConfig)}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** All members failed */
export const AllErrors: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: { dryRun: args.dryRun, frozen: false, pull: false, all: false },
        results: [
          { name: 'effect', status: 'error' as const, message: 'network timeout' },
          { name: 'effect-utils', status: 'error' as const, message: 'authentication failed' },
          { name: 'livestore', status: 'error' as const, message: 'repository not found' },
          { name: 'private-repo', status: 'error' as const, message: 'permission denied' },
        ],
        members: ['effect', 'effect-utils', 'livestore', 'private-repo'],
      }),
      [args.dryRun],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(args.interactive ? { phase: 'idle' } : stateConfig)}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Members skipped for various reasons */
export const SkippedMembers: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: { dryRun: args.dryRun, frozen: false, pull: false, all: false },
        results: [
          { name: 'effect', status: 'synced' as const, ref: 'main' },
          { name: 'dirty-repo', status: 'skipped' as const, message: 'dirty worktree' },
          { name: 'pinned-repo', status: 'skipped' as const, message: 'pinned' },
          { name: 'private-repo', status: 'skipped' as const, message: 'authentication required' },
        ] satisfies MemberSyncResult[],
        members: ['effect', 'dirty-repo', 'pinned-repo', 'private-repo'],
      }),
      [args.dryRun],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(args.interactive ? { phase: 'idle' } : stateConfig)}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Mixed skipped reasons */
export const MixedSkipped: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: { dryRun: args.dryRun, frozen: false, pull: false, all: false },
        results: [
          { name: 'effect', status: 'already_synced' as const },
          { name: 'dirty-repo', status: 'skipped' as const, message: '5 uncommitted changes' },
          { name: 'pinned-repo', status: 'skipped' as const, message: 'pinned to v1.0.0' },
          { name: 'auth-repo', status: 'skipped' as const, message: 'authentication required' },
          { name: 'missing-ref', status: 'skipped' as const, message: 'ref feature/x not found' },
        ] satisfies MemberSyncResult[],
        members: ['effect', 'dirty-repo', 'pinned-repo', 'auth-repo', 'missing-ref'],
      }),
      [args.dryRun],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(args.interactive ? { phase: 'idle' } : stateConfig)}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Issue #88: Ref mismatch detection */
export const RefMismatchDetected: Story = {
  args: { height: 500 },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: { dryRun: args.dryRun, frozen: false, pull: false, all: false },
        results: [
          { name: 'effect', status: 'synced' as const, ref: 'main' },
          {
            name: 'effect-utils',
            status: 'skipped' as const,
            refMismatch: {
              expectedRef: 'main',
              actualRef: 'feature-branch',
              isDetached: false,
            },
          },
          {
            name: 'livestore',
            status: 'skipped' as const,
            refMismatch: {
              expectedRef: 'main',
              actualRef: 'abc1234',
              isDetached: true,
            },
          },
          { name: 'other-repo', status: 'synced' as const, ref: 'develop' },
        ] satisfies MemberSyncResult[],
        members: ['effect', 'effect-utils', 'livestore', 'other-repo'],
      }),
      [args.dryRun],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(args.interactive ? { phase: 'idle' } : stateConfig)}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Sync interrupted */
export const Interrupted: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: { dryRun: args.dryRun, frozen: false, pull: false, all: false },
        phase: 'interrupted' as const,
        members: ['effect', 'effect-utils', 'livestore', 'dotfiles'],
        results: [
          { name: 'effect', status: 'synced' as const, ref: 'main' },
          { name: 'effect-utils', status: 'cloned' as const, ref: 'main' },
        ] satisfies MemberSyncResult[],
      }),
      [args.dryRun],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(args.interactive ? { phase: 'idle' } : stateConfig)}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}
