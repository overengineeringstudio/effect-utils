/**
 * Stories for pre-flight hygiene check failures shown before sync/apply/lock.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { SyncApp } from '../../mod.ts'
import { SyncView } from '../../view.tsx'
import * as sharedFixtures from '../_fixtures.ts'

type StoryArgs = {
  height: number
}

export default {
  component: SyncView,
  title: 'CLI/Preflight',
  parameters: { layout: 'fullscreen' },
  args: {
    height: 400,
  },
  argTypes: {
    height: {
      description: 'Terminal height in pixels',
      control: { type: 'range', min: 200, max: 600, step: 50 },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Pre-flight failure during `mr apply` — ref mismatch and broken worktree */
export const ApplyPreflightFailed: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr apply"
      View={SyncView}
      app={SyncApp}
      initialState={sharedFixtures.createPreflightFailedState({
        mode: 'apply',
        issues: sharedFixtures.examplePreflightIssues,
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** Pre-flight failure during `mr lock` — same issues, different mode badge */
export const LockPreflightFailed: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr lock"
      View={SyncView}
      app={SyncApp}
      initialState={sharedFixtures.createPreflightFailedState({
        mode: 'lock',
        issues: sharedFixtures.examplePreflightIssues,
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** Pre-flight failure with only errors (no warnings) */
export const ErrorsOnly: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr apply"
      View={SyncView}
      app={SyncApp}
      initialState={sharedFixtures.createPreflightFailedState({
        mode: 'apply',
        issues: sharedFixtures.examplePreflightIssues.filter((i) => i.severity === 'error'),
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** Pre-flight failure with a single missing bare repo issue */
export const SingleIssue: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr apply"
      View={SyncView}
      app={SyncApp}
      initialState={sharedFixtures.createPreflightFailedState({
        mode: 'apply',
        issues: [
          {
            severity: 'error',
            type: 'missing_bare',
            memberName: 'dotfiles',
            message: 'bare repo not found at ~/.megarepo/github.com/alice/dotfiles/bare',
            fix: "run 'mr apply' to clone the bare repo",
          },
        ],
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
