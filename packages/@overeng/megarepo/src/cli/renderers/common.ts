/**
 * Common rendering utilities for megarepo CLI output
 *
 * Following the CLI style guide at /context/cli-design/CLI_STYLE_GUIDE.md
 */

import { Console, Effect } from 'effect'

import { styled, symbols } from '@overeng/cli-ui'

// =============================================================================
// Output Helpers
// =============================================================================

/**
 * Output multiple lines to console.
 * Uses Console.log from Effect for clean output without timestamps.
 */
export const outputLines = (lines: readonly string[]) =>
  Effect.gen(function* () {
    for (const line of lines) {
      yield* Console.log(line)
    }
  })

// =============================================================================
// Member State Formatting
// =============================================================================

/** Member synchronization state */
export type MemberState =
  | { _tag: 'synced'; name: string }
  | { _tag: 'missing'; name: string }
  | { _tag: 'error'; name: string; message: string }

/** Format a member state line */
export const formatMemberState = (state: MemberState): string => {
  switch (state._tag) {
    case 'synced':
      return `${styled.green(symbols.check)} ${state.name}`
    case 'missing':
      return `${styled.yellow(symbols.circle)} ${state.name} ${styled.dim('(not synced)')}`
    case 'error':
      return `${styled.red(symbols.cross)} ${state.name} ${styled.dim(`(${state.message})`)}`
  }
}

// =============================================================================
// Sync Result Formatting
// =============================================================================

/** Sync operation result status */
export type SyncStatus = 'cloned' | 'synced' | 'already_synced' | 'skipped' | 'error'

/** Format a sync result line */
export const formatSyncResult = ({
  name,
  status,
  message,
}: {
  name: string
  status: SyncStatus
  message?: string
}): string => {
  const statusSymbol =
    status === 'error'
      ? styled.red(symbols.cross)
      : status === 'already_synced'
        ? styled.dim(symbols.check)
        : styled.green(symbols.check)

  const statusText =
    status === 'cloned'
      ? 'cloned'
      : status === 'synced'
        ? 'synced'
        : status === 'already_synced'
          ? 'already synced'
          : status === 'error'
            ? `error: ${message}`
            : status === 'skipped'
              ? `skipped${message ? `: ${message}` : ''}`
              : status

  return `${statusSymbol} ${styled.bold(name)} ${styled.dim(`(${statusText})`)}`
}

// =============================================================================
// Action Line Formatting (for dry-run output)
// =============================================================================

/**
 * Format an action line for dry-run output
 * e.g., "  will clone effect  because not on disk"
 */
export const formatActionLine = ({
  action,
  actionStyle,
  name,
  reason,
}: {
  action: string
  actionStyle: (s: string) => string
  name: string
  reason?: string
}): string => {
  const actionPart = actionStyle(action)
  const reasonPart = reason ? `  ${styled.dim(reason)}` : ''
  return `  ${actionPart} ${styled.bold(name)}${reasonPart}`
}
