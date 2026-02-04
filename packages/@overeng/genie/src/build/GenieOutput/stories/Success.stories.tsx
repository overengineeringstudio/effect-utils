/**
 * Result state stories for GenieOutput - various completion scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { GenieApp } from '../../app.ts'
import { GenieView } from '../../view.tsx'
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
  mode: 'generate' | 'check' | 'dry-run'
}

export default {
  component: GenieView,
  title: 'CLI/Genie/Results',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    height: 400,
    interactive: false,
    playbackSpeed: 1,
    mode: 'generate',
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
    mode: {
      description: 'Operation mode',
      control: { type: 'select' },
      options: ['generate', 'check', 'dry-run'],
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Mixed results - created, updated, unchanged files */
export const MixedResults: Story = {
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
        }),
      [args.mode],
    )

    const timeline = useMemo(
      () =>
        fixtures.createTimeline({
          mode: args.mode,
          files: fixtures.sampleFiles,
          results: [
            { path: fixtures.sampleFiles[0]!.path, status: 'created', linesAdded: 42 },
            {
              path: fixtures.sampleFiles[1]!.path,
              status: 'updated',
              linesAdded: 5,
              linesRemoved: 3,
            },
            { path: fixtures.sampleFiles[2]!.path, status: 'unchanged' },
            {
              path: fixtures.sampleFiles[3]!.path,
              status: 'updated',
              linesAdded: 12,
              linesRemoved: 8,
            },
            { path: fixtures.sampleFiles[4]!.path, status: 'unchanged' },
          ],
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
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline } : {})}
      />
    )
  },
}

/** All files unchanged - typical re-run scenario */
export const AllUnchanged: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () =>
        fixtures.createState({
          mode: args.mode,
          files: fixtures.sampleFiles.map((f) => ({ ...f, status: 'unchanged' as const })),
          summary: { created: 0, updated: 0, unchanged: 5, skipped: 0, failed: 0 },
        }),
      [args.mode],
    )

    const timeline = useMemo(
      () =>
        fixtures.createTimeline({
          mode: args.mode,
          files: fixtures.sampleFiles,
          results: fixtures.sampleFiles.map((f) => ({
            path: f.path,
            status: 'unchanged' as const,
          })),
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
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline } : {})}
      />
    )
  },
}

/** Dry run mode - shows what would be changed */
export const DryRun: Story = {
  args: {
    mode: 'dry-run',
  },
  render: (args) => {
    const dryRunFiles = [
      { path: '/workspace/packages/foo/package.json', relativePath: 'packages/foo/package.json' },
      { path: '/workspace/packages/foo/tsconfig.json', relativePath: 'packages/foo/tsconfig.json' },
      { path: '/workspace/packages/bar/package.json', relativePath: 'packages/bar/package.json' },
    ]

    const stateConfig = useMemo(
      () =>
        fixtures.createState({
          mode: args.mode,
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
        }),
      [args.mode],
    )

    const timeline = useMemo(
      () =>
        fixtures.createTimeline({
          mode: args.mode,
          files: dryRunFiles,
          results: [
            { path: '/workspace/packages/foo/package.json', status: 'created', linesAdded: 35 },
            {
              path: '/workspace/packages/foo/tsconfig.json',
              status: 'updated',
              linesAdded: 8,
              linesRemoved: 3,
            },
            { path: '/workspace/packages/bar/package.json', status: 'unchanged' },
          ],
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
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline } : {})}
      />
    )
  },
}

/** Check mode - all files up to date (success) */
export const CheckModeSuccess: Story = {
  args: {
    mode: 'check',
  },
  render: (args) => {
    const stateConfig = useMemo(
      () =>
        fixtures.createState({
          mode: args.mode,
          files: fixtures.sampleFiles.map((f) => ({ ...f, status: 'unchanged' as const })),
          summary: { created: 0, updated: 0, unchanged: 5, skipped: 0, failed: 0 },
        }),
      [args.mode],
    )

    const timeline = useMemo(
      () =>
        fixtures.createTimeline({
          mode: args.mode,
          files: fixtures.sampleFiles,
          results: fixtures.sampleFiles.map((f) => ({
            path: f.path,
            status: 'unchanged' as const,
          })),
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
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline } : {})}
      />
    )
  },
}
