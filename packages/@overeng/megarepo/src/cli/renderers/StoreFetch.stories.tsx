/**
 * Storybook stories for StoreFetch output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import {
  StoreApp,
  StoreView,
  type StoreFetchResult,
  type StoreStateType,
} from './StoreOutput/mod.ts'

// =============================================================================
// Example Data
// =============================================================================

const exampleFetchResults: StoreFetchResult[] = [
  { path: 'github.com/effect-ts/effect', status: 'fetched' },
  { path: 'github.com/overengineeringstudio/effect-utils', status: 'fetched' },
  { path: 'github.com/schickling/dotfiles', status: 'error', message: 'network timeout' },
]

// =============================================================================
// State Factory
// =============================================================================

const createFetchState = (opts: {
  results: StoreFetchResult[]
  elapsedMs: number
}): StoreStateType => ({
  _tag: 'Fetch',
  basePath: '/Users/dev/.megarepo',
  results: opts.results,
  elapsedMs: opts.elapsedMs,
})

// =============================================================================
// Meta
// =============================================================================

export default {
  title: 'CLI/Store/Fetch',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Output for the `mr store fetch` command. Shows fetch results for all repositories.',
      },
    },
  },
} satisfies Meta

type Story = StoryObj<{ height?: number }>

// =============================================================================
// Stories
// =============================================================================

export const Success: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={createFetchState({
        results: [
          { path: 'github.com/effect-ts/effect', status: 'fetched' },
          { path: 'github.com/overengineeringstudio/effect-utils', status: 'fetched' },
          { path: 'github.com/schickling/dotfiles', status: 'fetched' },
        ],
        elapsedMs: 1850,
      })}
    />
  ),
}

export const WithErrors: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={createFetchState({
        results: exampleFetchResults,
        elapsedMs: 3200,
      })}
    />
  ),
}

export const AllErrors: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={createFetchState({
        results: [
          { path: 'github.com/effect-ts/effect', status: 'error', message: 'network timeout' },
          { path: 'github.com/private/repo', status: 'error', message: 'authentication failed' },
        ],
        elapsedMs: 30500,
      })}
    />
  ),
}
