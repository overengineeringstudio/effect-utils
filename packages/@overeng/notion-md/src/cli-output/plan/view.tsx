import { type Atom } from '@effect-atom/atom'
import React from 'react'

import { CommandOutput, type ProblemItem, useTuiAtomValue } from '@overeng/tui-react'

import type { PlanState } from './schema.ts'

/** Props for {@link PlanView}. */
export interface PlanViewProps {
  readonly stateAtom: Atom.Atom<PlanState>
}

/** Context header line for the `plan` output (`notion-md plan · <target>`). */
const contextLine = (target: string): string =>
  target.length === 0 ? 'notion-md plan' : `notion-md plan · ${target}`

/**
 * Problems for the view: the precomputed result problems on `Success`, or — on
 * the terminal `Error` — a problems-first CRITICAL so the most blocking outcome
 * reads loudest (the dim `failed · <msg>` summary stays as-is). Generic failures
 * carry no fabricated fix, just a `status` inspect hint when the target is known.
 */
const problemsFor = (state: PlanState): readonly ProblemItem[] => {
  if (state._tag === 'Success') return state.problems
  return [
    {
      severity: 'critical',
      name: state.target.length === 0 ? 'plan' : state.target,
      status: 'failed',
      details: state.message,
      fixes: state.target.length === 0 ? [] : [`notion-md status ${state.target}`],
    },
  ]
}

/** The dimmed `·`-joined summary line for a terminal state. */
const summaryParts = (state: PlanState): readonly string[] =>
  state._tag === 'Error' ? ['failed', state.message] : state.summary

/**
 * Render the read-only `plan` dry-run diff through the shared `/sk-cli-design`
 * kit: blocked / conflicting ops surface as WARNING/CRITICAL `problems` (with an
 * actionable `fix:`), the would-change ops come through `sections` grouped by
 * op-kind (`create(N): …`, truncating `+ N more`), and the op counts come through
 * the dimmed summary line. Stage-less — there is no write progress. All
 * glyph/color/stream choices flow through the active OutputMode, so a pipe gets
 * clean JSON/log and a TTY gets the rendered output.
 */
export const PlanView = ({ stateAtom }: PlanViewProps): React.ReactElement => {
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
