import { type Atom } from '@effect-atom/atom'
import React from 'react'

import {
  Box,
  type DetailSection,
  type ProblemItem,
  ProblemList,
  DetailSections,
  SeverityBadge,
  StatusGlyph,
  SummaryLine,
  Text,
  useSymbols,
  useTuiAtomValue,
} from '@overeng/tui-react'

import type { WatchCounters, WatchEvent, WatchState } from './schema.ts'

/** Props for {@link WatchView}. */
export interface WatchViewProps {
  readonly stateAtom: Atom.Atom<WatchState>
}

/** The counter buckets shown in the summary, in display order. */
const SUMMARY_BUCKETS: readonly (keyof WatchCounters)[] = [
  'pushed',
  'pulled',
  'noop',
  'conflict',
  'error',
]

/** `notion-md sync --watch · <target>` context fragment for the status line. */
const contextLabel = (target: string): string =>
  target.length === 0 ? 'notion-md sync --watch' : `notion-md sync --watch · ${target}`

/** `last: <label> (<reason>)` fragment, or a pre-first-pass placeholder. */
const lastFragment = (state: WatchState): string => {
  if (state.lastResult === undefined) return 'waiting for first pass…'
  return `last: ${state.lastResult.label} (${state.lastResult.reason})`
}

/** `polling every <interval>ms` fragment (omitted when no interval is known). */
const pollingFragment = (pollIntervalMs: number): string | undefined =>
  pollIntervalMs > 0 ? `polling every ${pollIntervalMs}ms` : undefined

/** Recent passes as one truncating `events(N):` detail section (newest first). */
const eventSections = (events: readonly WatchEvent[]): readonly DetailSection[] => {
  if (events.length === 0) return []
  // Ring is oldest-first internally; reverse for newest-first display.
  const rows = events.toReversed().map((event) => `${event.label} (${event.reason})`)
  return [{ title: 'events', items: rows }]
}

/** `N files · watch active · last <label>` — dimmed summary line. */
const summaryParts = (state: WatchState): readonly string[] => {
  const counts = state.counters
  const total = SUMMARY_BUCKETS.reduce((sum, bucket) => sum + counts[bucket], 0)
  const buckets = SUMMARY_BUCKETS.filter((bucket) => counts[bucket] > 0).map(
    (bucket) => `${counts[bucket]} ${bucket}`,
  )
  const head = `${total} pass${total === 1 ? '' : 'es'}`
  const status = state.active === true ? 'watch active' : 'watch starting…'
  const last = state.lastResult === undefined ? [] : [`last ${state.lastResult.label}`]
  return [head, ...buckets, status, ...last]
}

/** WARNING problems for the last pass when it conflicted or failed. */
const warnings = (state: WatchState): readonly ProblemItem[] => {
  const last = state.lastResult
  if (last === undefined || last.problem === false) return []
  return [
    {
      severity: 'warning',
      name: state.target,
      status: last.label,
      details: last.detail ?? 'most recent pass needs attention',
      fixes: [`notion-md status ${state.target} to inspect`],
    },
  ]
}

/**
 * Render the `sync --watch` live human view through the `/sk-cli-design` kit.
 *
 * Layout (problems-first per `/sk-cli-design`):
 *
 * ```
 * <glyph> notion-md sync --watch · <target> · last: <label> (<reason>) · polling every <n>ms
 *
 * WARNING                  (only when the last pass conflicted/failed)
 *   <target> <label> <detail>
 *     fix: notion-md status <target> to inspect
 * ───
 * events(N):
 *   <label> (<reason>)     (newest first, capped at 5)
 *
 * <total> passes · <buckets> · watch active · last <label>
 * ```
 *
 * The live status line leads with a {@link StatusGlyph} (`ok` while the last
 * pass is clean, `error` when it conflicted/failed). Counters and the ring
 * accumulate across passes; the machine modes never reach this view.
 */
export const WatchView = ({ stateAtom }: WatchViewProps): React.ReactElement => {
  const state = useTuiAtomValue(stateAtom)
  const symbols = useSymbols()
  const problems = warnings(state)
  const sections = eventSections(state.recentEvents)
  const glyphKind = state.lastResult?.problem === true ? 'error' : 'ok'
  const statusParts = [
    contextLabel(state.target),
    lastFragment(state),
    pollingFragment(state.pollIntervalMs),
  ].filter((part): part is string => part !== undefined)

  const blocks: React.ReactNode[] = []
  blocks.push(
    <Box key="status" flexDirection="row">
      <StatusGlyph kind={glyphKind} />
      <Text>{` ${statusParts.join(' · ')}`}</Text>
    </Box>,
  )
  if (problems.length > 0) {
    blocks.push(
      <Box key="problems">
        <SeverityBadge severity="warning" />
        <Text>{''}</Text>
        <ProblemList items={problems} />
      </Box>,
    )
    blocks.push(
      <Text key="sep" dim>
        {symbols.line.horizontal.repeat(3)}
      </Text>,
    )
  }
  if (sections.length > 0) blocks.push(<DetailSections key="events" sections={sections} />)
  blocks.push(<SummaryLine key="summary" parts={summaryParts(state)} />)

  return (
    <Box>
      {blocks.map((block, index) => (
        <Box key={`watch-block-${index}`}>
          {index > 0 && <Text>{''}</Text>}
          {block}
        </Box>
      ))}
    </Box>
  )
}
