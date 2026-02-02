/**
 * Storybook stories for StoreAdd output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StoreApp, StoreView, type StoreStateType } from './StoreOutput/mod.ts'

// =============================================================================
// State Factories
// =============================================================================

const createAddState = (opts: {
  status: 'added' | 'already_exists'
  source: string
  ref: string
  commit?: string
  path: string
}): StoreStateType => ({
  _tag: 'Add',
  status: opts.status,
  source: opts.source,
  ref: opts.ref,
  commit: opts.commit,
  path: opts.path,
})

const createErrorState = (opts: {
  error: string
  message: string
  source?: string
}): StoreStateType => ({
  _tag: 'Error',
  error: opts.error,
  message: opts.message,
  source: opts.source,
})

// =============================================================================
// Meta
// =============================================================================

export default {
  component: StoreView,
  title: 'CLI/Store/Add',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Output for the `mr store add` command. Shows add results and errors.',
      },
    },
  },
} satisfies Meta

type Story = StoryObj<{ height?: number }>

// =============================================================================
// Error Stories
// =============================================================================

export const InvalidSource: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={createErrorState({
        error: 'invalid_source',
        message: "Invalid source: 'not-a-valid-source'",
        source: 'not-a-valid-source',
      })}
    />
  ),
}

export const LocalPath: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={createErrorState({
        error: 'local_path',
        message: 'Local paths are not supported. Use a remote URL or owner/repo format.',
      })}
    />
  ),
}

export const NoUrl: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={createErrorState({
        error: 'no_url',
        message: 'No URL provided',
      })}
    />
  ),
}

// =============================================================================
// Success Stories
// =============================================================================

export const SuccessNew: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={createAddState({
        status: 'added',
        source: 'effect-ts/effect',
        ref: 'main',
        commit: 'abc1234567890',
        path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/main',
      })}
    />
  ),
}

export const SuccessExisting: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={createAddState({
        status: 'already_exists',
        source: 'effect-ts/effect',
        ref: 'main',
        commit: 'abc1234567890',
        path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/main',
      })}
    />
  ),
}

export const SuccessWithRef: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={createAddState({
        status: 'added',
        source: 'effect-ts/effect#feat/new-feature',
        ref: 'feat/new-feature',
        commit: 'def456789012',
        path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/feat/new-feature',
      })}
    />
  ),
}

export const SuccessNoCommit: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={createAddState({
        status: 'added',
        source: 'effect-ts/effect',
        ref: 'v3.0.0',
        path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/v3.0.0',
      })}
    />
  ),
}
