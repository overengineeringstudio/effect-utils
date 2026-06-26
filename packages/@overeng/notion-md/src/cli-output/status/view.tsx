import { type Atom } from '@effect-atom/atom'
import React from 'react'

import { CommandOutput, type ProblemItem, useTuiAtomValue } from '@overeng/tui-react'

import type { StatusState } from './schema.ts'

/** Props for {@link StatusView}. */
export interface StatusViewProps {
  readonly stateAtom: Atom.Atom<StatusState>
}

/** Context header line for the `status` output (`notion-md status · <target>`). */
const contextLine = (target: string): string =>
  target.length === 0 ? 'notion-md status' : `notion-md status · ${target}`

/**
 * Problems for the view: the precomputed result problems on `Success`, or — on
 * the terminal `Error` — a problems-first CRITICAL so the most blocking outcome
 * reads loudest (the dim `failed · <msg>` summary stays as-is). Re-running
 * `status` is the failed command itself, so no fix is offered (none to fabricate).
 */
const problemsFor = (state: StatusState): readonly ProblemItem[] => {
  if (state._tag === 'Success') return state.problems
  return [
    {
      severity: 'critical',
      name: state.target.length === 0 ? 'status' : state.target,
      status: 'failed',
      details: state.message,
      fixes: [],
    },
  ]
}

/** The dimmed `·`-joined summary line for a terminal state. */
const summaryParts = (state: StatusState): readonly string[] =>
  state._tag === 'Error' ? ['failed', state.message] : state.summary

/**
 * Render the read-only `status` output through the shared `/sk-cli-design` kit:
 * drift / unresolved-unknown-blocks / per-page divergence surface as WARNING
 * `problems` (with an actionable `fix:`), the per-page or per-flag detail comes
 * through `sections` (truncating `+ N more`), and the counts come through the
 * dimmed summary line. Stage-less — there is no write progress to render. All
 * glyph/color/stream choices flow through the active OutputMode, so a pipe gets
 * clean JSON/log and a TTY gets the rendered output.
 */
export const StatusView = ({ stateAtom }: StatusViewProps): React.ReactElement => {
  const state = useTuiAtomValue(stateAtom)
  return (
    <CommandOutput
      context={contextLine(state.target)}
      problems={problemsFor(state)}
      sections={state._tag === 'Success' ? state.sections : []}
      summary={summaryParts(state)}
    />
  )
}
