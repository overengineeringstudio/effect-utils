/**
 * Shared fixtures for StoreOutput stories.
 *
 * @internal
 */

import type {
  StoreState as StoreStateType,
  StoreFetchResult,
  StoreGcResult,
  StoreGcWarning,
  StoreRepo,
  StoreWorktreeStatus,
} from '../mod.ts'

// Re-export types for use in stories
export type { StoreGcResult, StoreGcWarning }

// =============================================================================
// Add Command - State Factories
// =============================================================================

export const createAddState = (opts: {
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

export const createErrorState = (opts: {
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
// Fetch Command - Example Data & State Factory
// =============================================================================

export const exampleFetchResults: StoreFetchResult[] = [
  { path: 'github.com/effect-ts/effect', status: 'fetched' },
  { path: 'github.com/overengineeringstudio/effect-utils', status: 'fetched' },
  { path: 'github.com/schickling/dotfiles', status: 'error', message: 'network timeout' },
]

export const createFetchState = (opts: {
  results: StoreFetchResult[]
  elapsedMs: number
}): StoreStateType => ({
  _tag: 'Fetch',
  basePath: '/Users/dev/.megarepo',
  results: opts.results,
  elapsedMs: opts.elapsedMs,
})

// =============================================================================
// Fetch Command - Timeline Factory for Animated Stories
// =============================================================================

type FetchTimelineAction = {
  _tag: 'SetFetch'
  basePath: string
  results: StoreFetchResult[]
  elapsedMs: number
}

/**
 * Creates a timeline that animates fetching each repository progressively.
 * Each repository is fetched one at a time with a delay between them.
 */
export const createFetchTimeline = (finalState: {
  results: StoreFetchResult[]
  elapsedMs: number
}): Array<{ at: number; action: FetchTimelineAction }> => {
  const { results, elapsedMs } = finalState

  if (results.length === 0) {
    return [
      {
        at: 0,
        action: {
          _tag: 'SetFetch',
          basePath: '/Users/dev/.megarepo',
          results: [],
          elapsedMs,
        },
      },
    ]
  }

  const timeline: Array<{ at: number; action: FetchTimelineAction }> = []
  const stepDuration = 600
  const elapsedPerStep = elapsedMs / results.length

  // Start with empty results
  timeline.push({
    at: 0,
    action: {
      _tag: 'SetFetch',
      basePath: '/Users/dev/.megarepo',
      results: [],
      elapsedMs: 0,
    },
  })

  // Add each result progressively
  for (let i = 0; i < results.length; i++) {
    const currentResults = results.slice(0, i + 1)
    const currentElapsed = Math.round(elapsedPerStep * (i + 1))

    timeline.push({
      at: (i + 1) * stepDuration,
      action: {
        _tag: 'SetFetch',
        basePath: '/Users/dev/.megarepo',
        results: currentResults,
        elapsedMs: i === results.length - 1 ? elapsedMs : currentElapsed,
      },
    })
  }

  return timeline
}

// =============================================================================
// GC Command - Example Data & State Factory
// =============================================================================

export const exampleGcResults: StoreGcResult[] = [
  {
    repo: 'github.com/effect-ts/effect',
    ref: 'feat/old-branch',
    path: '/store/...',
    status: 'removed',
  },
  {
    repo: 'github.com/effect-ts/effect',
    ref: 'main',
    path: '/store/...',
    status: 'skipped_in_use',
  },
  {
    repo: 'github.com/overengineeringstudio/effect-utils',
    ref: 'dev',
    path: '/store/...',
    status: 'skipped_dirty',
  },
]

export const createGcState = (opts: {
  results: StoreGcResult[]
  dryRun: boolean
  force?: boolean
  all?: boolean
  warning?: StoreGcWarning
  showForceHint: boolean
}): StoreStateType => ({
  _tag: 'Gc',
  basePath: '/Users/dev/.megarepo',
  results: opts.results,
  dryRun: opts.dryRun,
  warning: opts.warning,
  showForceHint: opts.showForceHint,
})

// =============================================================================
// GC Command - Timeline Factory for Animated Stories
// =============================================================================

type GcTimelineAction = {
  _tag: 'SetGc'
  basePath: string
  results: StoreGcResult[]
  dryRun: boolean
  warning?: StoreGcWarning
  showForceHint: boolean
}

const makeGcAction = (opts: {
  dryRun: boolean
  results: StoreGcResult[]
  showForceHint: boolean
  warning?: StoreGcWarning
}): GcTimelineAction => {
  const action: GcTimelineAction = {
    _tag: 'SetGc',
    basePath: '/Users/dev/.megarepo',
    results: opts.results,
    dryRun: opts.dryRun,
    showForceHint: opts.showForceHint,
  }
  if (opts.warning !== undefined) {
    action.warning = opts.warning
  }
  return action
}

/**
 * Creates a timeline that animates through GC results appearing progressively.
 * This ensures interactive mode shows the same end result as static mode.
 */
export const createGcTimeline = (config: {
  results: StoreGcResult[]
  dryRun: boolean
  force: boolean
  all: boolean
  warning?: StoreGcWarning
  showForceHint: boolean
}): Array<{ at: number; action: GcTimelineAction }> => {
  const { results, dryRun, warning, showForceHint } = config

  if (results.length === 0) {
    // No results - just show complete state
    return [
      {
        at: 0,
        action: makeGcAction({
          dryRun,
          results: [],
          showForceHint,
          ...(warning !== undefined ? { warning } : {}),
        }),
      },
    ]
  }

  const timeline: Array<{ at: number; action: GcTimelineAction }> = []
  const stepDuration = 600

  // Start with empty results
  timeline.push({ at: 0, action: makeGcAction({ dryRun, results: [], showForceHint: false }) })

  // Add each result progressively
  for (let i = 0; i < results.length; i++) {
    const currentResults = results.slice(0, i + 1)
    const isLast = i === results.length - 1

    timeline.push({
      at: (i + 1) * stepDuration,
      action: makeGcAction({
        dryRun,
        results: currentResults,
        showForceHint: isLast ? showForceHint : false,
        ...(isLast && warning !== undefined ? { warning } : {}),
      }),
    })
  }

  return timeline
}

// =============================================================================
// List Command - Example Data & State Factory
// =============================================================================

export const exampleStoreRepos: StoreRepo[] = [
  { relativePath: 'github.com/effect-ts/effect' },
  { relativePath: 'github.com/overengineeringstudio/effect-utils' },
  { relativePath: 'github.com/schickling/dotfiles' },
]

export const createLsState = (repos: StoreRepo[]): StoreStateType => ({
  _tag: 'Ls',
  basePath: '/Users/dev/.megarepo',
  repos,
})

// =============================================================================
// Status Command - Example Data & State Factory
// =============================================================================

export const healthyWorktrees: StoreWorktreeStatus[] = [
  {
    repo: 'github.com/effect-ts/effect/',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/effect-ts/effect/refs/heads/main/',
    issues: [],
  },
  {
    repo: 'github.com/overengineeringstudio/effect-utils/',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/overengineeringstudio/effect-utils/refs/heads/main/',
    issues: [],
  },
]

export const mixedIssuesWorktrees: StoreWorktreeStatus[] = [
  {
    repo: 'github.com/effect-ts/effect/',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/effect-ts/effect/refs/heads/main/',
    issues: [],
  },
  {
    repo: 'github.com/livestorejs/livestore/',
    ref: 'dev',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/livestorejs/livestore/refs/heads/dev/',
    issues: [
      {
        type: 'ref_mismatch',
        severity: 'error',
        message: "path says 'dev' but HEAD is 'refactor/genie-igor-ci'",
      },
      { type: 'dirty', severity: 'warning', message: '27 uncommitted changes' },
      { type: 'orphaned', severity: 'info', message: 'not in current megarepo.lock' },
    ],
  },
  {
    repo: 'github.com/overengineeringstudio/effect-utils/',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/overengineeringstudio/effect-utils/refs/heads/main/',
    issues: [{ type: 'dirty', severity: 'warning', message: '36 uncommitted changes' }],
  },
  {
    repo: 'github.com/schickling/dotfiles/',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/schickling/dotfiles/refs/heads/main/',
    issues: [{ type: 'orphaned', severity: 'info', message: 'not in current megarepo.lock' }],
  },
]

export const createStatusState = (opts: {
  repoCount: number
  worktreeCount: number
  diskUsage?: string
  worktrees: StoreWorktreeStatus[]
}): StoreStateType => ({
  _tag: 'Status',
  basePath: '/Users/dev/.megarepo',
  repoCount: opts.repoCount,
  worktreeCount: opts.worktreeCount,
  diskUsage: opts.diskUsage,
  worktrees: opts.worktrees,
})
