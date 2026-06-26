import { type Atom } from '@effect-atom/atom'
import React from 'react'

import {
  CommandOutput,
  type DetailSection,
  type ProblemItem,
  useTuiAtomValue,
} from '@overeng/tui-react'

import type { SyncPageOutcome, SyncPageRow, SyncState } from './schema.ts'

/** Props for {@link SyncView}. */
export interface SyncViewProps {
  readonly stateAtom: Atom.Atom<SyncState>
}

/** Context header line for the `sync` output (`notion-md sync · <target>`). */
const contextLine = (target: string): string =>
  target.length === 0 ? 'notion-md sync' : `notion-md sync · ${target}`

/** The outcomes counted in the multi-page summary, in display order. */
const SUMMARY_OUTCOMES: readonly SyncPageOutcome[] = [
  'pushed',
  'pulled',
  'created',
  'updated',
  'moved',
  'materialized',
  'noop',
  'trashed',
  'blocked',
  'conflict',
  'error',
]

/** Per-page rows as one truncating detail section (`pages(N):` + `path  outcome`). */
const pageSections = (pages: readonly SyncPageRow[]): readonly DetailSection[] => {
  if (pages.length === 0) return []
  const rows = pages.map((page) => `${page.path}  ${page.outcome}`)
  return [
    {
      title: 'pages',
      items: rows.slice(0, 5),
      ...(rows.length > 5 ? { more: rows.length - 5 } : {}),
    },
  ]
}

/** `N pages · X pushed · Y pulled · …` — only non-zero buckets are listed. */
const multiSummary = (pages: readonly SyncPageRow[]): readonly string[] => {
  const counts = new Map<SyncPageOutcome, number>()
  for (const page of pages) counts.set(page.outcome, (counts.get(page.outcome) ?? 0) + 1)
  const parts = SUMMARY_OUTCOMES.filter((outcome) => (counts.get(outcome) ?? 0) > 0).map(
    (outcome) => `${counts.get(outcome) ?? 0} ${outcome}`,
  )
  return [`${pages.length} page${pages.length === 1 ? '' : 's'}`, ...parts]
}

/**
 * Problems for the view: any accumulated warnings, plus — on the terminal
 * `Error` — a problems-first CRITICAL so the most blocking outcome reads loudest
 * (the dim `failed · <msg>` summary and the `✗` stage row stay as-is). Generic
 * failures carry no fabricated fix, just an inspect hint when the target is known.
 */
const problemsFor = (state: SyncState): readonly ProblemItem[] => {
  if (state._tag !== 'Error') return state.warnings
  return [
    ...state.warnings,
    {
      severity: 'critical',
      name: state.target.length === 0 ? 'sync' : state.target,
      status: 'failed',
      details: state.message,
      fixes: state.target.length === 0 ? [] : [`notion-md status ${state.target}`],
    },
  ]
}

/** Build the dimmed `·`-joined summary line for a terminal state. */
const summaryParts = (state: SyncState): readonly string[] => {
  switch (state._tag) {
    case 'Running':
      return ['syncing…']
    case 'Success':
      return state.multi === true ? multiSummary(state.pages) : ['synced', state.target]
    case 'Conflict':
      return state.multi === true
        ? multiSummary(state.pages)
        : ['conflict', 'nothing pushed', state.target]
    case 'Error':
      return ['failed', state.message]
  }
}

/**
 * Render the one-shot `sync` output through the shared `/sk-cli-design` kit.
 *
 * SINGLE-page sync renders like `edit`: the live `stages` + a dimmed outcome
 * summary. MULTI-page (tree/batch) sync renders a per-page RESULT section plus a
 * counts summary (`N pages · X pushed · …`); its `stages` are empty because the
 * shared stage ids cannot be interleaved live across pages (see schema.ts). Any
 * conflict surfaces as a WARNING `problem` with an actionable `fix:`.
 */
export const SyncView = ({ stateAtom }: SyncViewProps): React.ReactElement => {
  const state = useTuiAtomValue(stateAtom)
  const pages = state._tag === 'Success' || state._tag === 'Conflict' ? state.pages : []
  return (
    <CommandOutput
      context={contextLine(state.target)}
      problems={problemsFor(state)}
      sections={pageSections(pages)}
      stages={state.stages}
      summary={summaryParts(state)}
    />
  )
}
