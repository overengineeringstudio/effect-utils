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
// WorktreeNew Command - State Factory
// =============================================================================

export const createWorktreeNewState = (opts: {
  source: string
  ref: string
  path: string
  commit?: string
  autoBootstrap: boolean
  branchCreated: boolean
}): StoreStateType => ({
  _tag: 'WorktreeNew',
  source: opts.source,
  ref: opts.ref,
  path: opts.path,
  commit: opts.commit,
  autoBootstrap: opts.autoBootstrap,
  branchCreated: opts.branchCreated,
})

// =============================================================================
// Fetch Command - Example Data & State Factory
// =============================================================================

export const exampleFetchResults: StoreFetchResult[] = [
  { path: 'github.com/alice/core-lib', status: 'fetched' },
  { path: 'github.com/acme-org/dev-tools', status: 'fetched' },
  { path: 'github.com/alice/dotfiles', status: 'error', message: 'network timeout' },
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
    repo: 'github.com/alice/core-lib',
    ref: 'a87e1b0c4d5f678901234567890123456789abcd',
    refType: 'commits',
    path: '/Users/dev/.megarepo/github.com/alice/core-lib/refs/commits/a87e1b0c4d5f678901234567890123456789abcd/',
    status: 'removed',
  },
  {
    repo: 'github.com/alice/core-lib',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/alice/core-lib/refs/heads/main/',
    status: 'skipped_in_use',
    message: 'named branch ref',
  },
  {
    repo: 'github.com/acme-org/dev-tools',
    ref: 'c92e1b0c4d5f678901234567890123456789abcd',
    refType: 'commits',
    path: '/Users/dev/.megarepo/github.com/acme-org/dev-tools/refs/commits/c92e1b0c4d5f678901234567890123456789abcd/',
    status: 'skipped_dirty',
  },
]

/**
 * Cold named-branch GC outcomes (decisions 0001–0010): a merged branch archived
 * to `.archive/` with a recovery hint, a stale archive reaped past retention, and
 * cold-but-kept worktrees (live / unrecoverable-local-work / ref_mismatch).
 */
export const exampleColdGcResults: StoreGcResult[] = [
  {
    repo: 'github.com/alice/core-lib/',
    ref: 'feature/merged-pr',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/alice/core-lib/refs/heads/feature/merged-pr/',
    status: 'archived',
    reason: 'merged',
    recoverPath:
      '/Users/dev/.megarepo/github.com/alice/core-lib/.archive/feature/merged-pr--2026-06-11T08:00:00.000Z/',
  },
  {
    repo: 'github.com/alice/core-lib/',
    ref: 'feature/old-archive',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/alice/core-lib/.archive/feature/old-archive--2026-05-01T00:00:00.000Z/',
    status: 'reaped',
    reason: 'retention',
  },
  {
    repo: 'github.com/acme-org/dev-tools/',
    ref: 'feature/unpushed',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/acme-org/dev-tools/refs/heads/feature/unpushed/',
    status: 'kept',
    reason: 'unrecoverable-local-work',
  },
  {
    repo: 'github.com/acme-org/dev-tools/',
    ref: 'feature/repinned',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/acme-org/dev-tools/refs/heads/feature/repinned/',
    status: 'kept',
    reason: 'live',
  },
  {
    repo: 'github.com/acme-org/dev-tools/',
    ref: 'feature/diverged',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/acme-org/dev-tools/refs/heads/feature/diverged/',
    status: 'kept',
    reason: 'ref_mismatch',
    message: "HEAD is 'feature/other'",
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
        showForceHint: isLast === true ? showForceHint : false,
        ...(isLast === true && warning !== undefined ? { warning } : {}),
      }),
    })
  }

  return timeline
}

// =============================================================================
// List Command - Example Data & State Factory
// =============================================================================

export const exampleStoreRepos: StoreRepo[] = [
  { relativePath: 'github.com/alice/core-lib' },
  { relativePath: 'github.com/acme-org/dev-tools' },
  { relativePath: 'github.com/alice/dotfiles' },
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
    repo: 'github.com/alice/core-lib/',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/alice/core-lib/refs/heads/main/',
    issues: [],
  },
  {
    repo: 'github.com/acme-org/dev-tools/',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/acme-org/dev-tools/refs/heads/main/',
    issues: [],
  },
]

export const mixedIssuesWorktrees: StoreWorktreeStatus[] = [
  {
    repo: 'github.com/alice/core-lib/',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/alice/core-lib/refs/heads/main/',
    issues: [],
  },
  {
    repo: 'github.com/acme-org/app-platform/',
    ref: 'dev',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/acme-org/app-platform/refs/heads/dev/',
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
    repo: 'github.com/acme-org/dev-tools/',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/acme-org/dev-tools/refs/heads/main/',
    issues: [{ type: 'dirty', severity: 'warning', message: '36 uncommitted changes' }],
  },
  {
    repo: 'github.com/alice/dotfiles/',
    ref: 'main',
    refType: 'heads',
    path: '/Users/dev/.megarepo/github.com/alice/dotfiles/refs/heads/main/',
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

// =============================================================================
// Fix Command - Example Data & State Factory
// =============================================================================

import type { StoreFixResult } from '../mod.ts'

export type { StoreFixResult }

export const fixResultsMixed: StoreFixResult[] = [
  {
    memberName: 'app-platform',
    issueType: 'ref_mismatch',
    status: 'fixed',
    message: "checked out expected branch 'dev'",
  },
  {
    memberName: 'dev-tools',
    issueType: 'broken_worktree',
    status: 'fixed',
    message: 're-linked .git file to bare repository',
  },
  {
    memberName: 'dotfiles',
    issueType: 'missing_bare',
    status: 'error',
    message: 'failed to clone: network timeout',
  },
]

export const fixResultsAllFixed: StoreFixResult[] = [
  {
    memberName: 'app-platform',
    issueType: 'ref_mismatch',
    status: 'fixed',
    message: "checked out expected branch 'dev'",
  },
  {
    memberName: 'dev-tools',
    issueType: 'broken_worktree',
    status: 'fixed',
    message: 're-linked .git file to bare repository',
  },
]

export const fixResultsDryRun: StoreFixResult[] = [
  {
    memberName: 'app-platform',
    issueType: 'ref_mismatch',
    status: 'skipped',
    message: "would check out expected branch 'dev'",
  },
  {
    memberName: 'dev-tools',
    issueType: 'broken_worktree',
    status: 'skipped',
    message: 'would re-link .git file to bare repository',
  },
]

export const createFixState = (opts: {
  results: StoreFixResult[]
  dryRun: boolean
  noIssues: boolean
}): StoreStateType => ({
  _tag: 'Fix',
  basePath: '/Users/dev/.megarepo',
  results: opts.results,
  dryRun: opts.dryRun,
  noIssues: opts.noIssues,
})
