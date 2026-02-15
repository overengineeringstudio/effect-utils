/**
 * Summary Component
 *
 * Result counts summary line.
 */

import React from 'react'

import { Box, Text } from '@overeng/tui-react'

import { symbols } from './tokens.ts'

// =============================================================================
// Types
// =============================================================================

/** Counts of sync results by category, used to render the summary line. */
export interface SummaryCounts {
  cloned?: number
  synced?: number
  updated?: number
  locked?: number
  removed?: number
  errors?: number
  skipped?: number
  alreadySynced?: number
}

/** Props for the Summary component that renders a dot-separated result counts line. */
export interface SummaryProps {
  /** Result counts */
  counts: SummaryCounts
  /** Whether this is a dry run (changes "cloned" to "to clone", etc.) */
  dryRun?: boolean
}

// =============================================================================
// Component
// =============================================================================

/**
 * Summary - Result counts summary
 *
 * Renders a dot-separated summary of results:
 * ```
 * 3 cloned · 2 synced · 1 updated · 1 error
 * ```
 *
 * In dry run mode:
 * ```
 * 3 to clone · 2 to sync · 1 to update
 * ```
 *
 * @example
 * ```tsx
 * <Summary counts={{ cloned: 3, synced: 2, errors: 1 }} />
 * <Summary counts={{ cloned: 3, synced: 2 }} dryRun />
 * ```
 */
export const Summary = ({ counts, dryRun = false }: SummaryProps) => {
  const parts: Array<{ key: string; element: React.ReactNode }> = []

  if (dryRun) {
    if (counts.cloned !== undefined && counts.cloned !== undefined > 0)
      parts.push({ key: 'cloned', element: <Text dim>{counts.cloned} to clone</Text> })
    if (counts.synced !== undefined && counts.synced !== undefined > 0)
      parts.push({ key: 'synced', element: <Text dim>{counts.synced} to sync</Text> })
    if (counts.updated !== undefined && counts.updated !== undefined > 0)
      parts.push({ key: 'updated', element: <Text dim>{counts.updated} to update</Text> })
    if (counts.locked !== undefined && counts.locked !== undefined > 0)
      parts.push({ key: 'locked', element: <Text dim>{counts.locked} lock updates</Text> })
    if (counts.removed !== undefined && counts.removed !== undefined > 0)
      parts.push({ key: 'removed', element: <Text color="red">{counts.removed} to remove</Text> })
    if (counts.errors !== undefined && counts.errors !== undefined > 0)
      parts.push({ key: 'errors', element: <Text color="red">{counts.errors} errors</Text> })
    if (counts.alreadySynced !== undefined && counts.alreadySynced !== undefined > 0)
      parts.push({ key: 'unchanged', element: <Text dim>{counts.alreadySynced} unchanged</Text> })
  } else {
    if (counts.cloned !== undefined && counts.cloned !== undefined > 0)
      parts.push({ key: 'cloned', element: <Text dim>{counts.cloned} cloned</Text> })
    if (counts.synced !== undefined && counts.synced !== undefined > 0)
      parts.push({ key: 'synced', element: <Text dim>{counts.synced} synced</Text> })
    if (counts.updated !== undefined && counts.updated !== undefined > 0)
      parts.push({ key: 'updated', element: <Text dim>{counts.updated} updated</Text> })
    if (counts.locked !== undefined && counts.locked !== undefined > 0)
      parts.push({ key: 'locked', element: <Text dim>{counts.locked} lock updates</Text> })
    if (counts.removed !== undefined && counts.removed !== undefined > 0)
      parts.push({ key: 'removed', element: <Text color="red">{counts.removed} removed</Text> })
    if (counts.errors !== undefined && counts.errors !== undefined > 0)
      parts.push({ key: 'errors', element: <Text color="red">{counts.errors} errors</Text> })
    if (counts.alreadySynced !== undefined && counts.alreadySynced !== undefined > 0)
      parts.push({ key: 'unchanged', element: <Text dim>{counts.alreadySynced} unchanged</Text> })
  }

  if (parts.length === 0) {
    parts.push({ key: 'no-changes', element: <Text dim>no changes</Text> })
  }

  return (
    <Box flexDirection="row">
      {parts.map((part, i) => (
        <React.Fragment key={part.key}>
          {i > 0 && <Text dim> {symbols.dot} </Text>}
          {part.element}
        </React.Fragment>
      ))}
    </Box>
  )
}
