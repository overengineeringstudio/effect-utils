import { type Atom } from '@effect-atom/atom'
import React from 'react'

import { CommandOutput, type ProblemItem, useTuiAtomValue } from '@overeng/tui-react'

import type { EditState } from './schema.ts'

/** Props for {@link EditView}. */
export interface EditViewProps {
  readonly stateAtom: Atom.Atom<EditState>
}

/** Context header line for the `edit` output (`notion-md edit · <page>`). */
const contextLine = (page: string): string =>
  page.length === 0 ? 'notion-md edit' : `notion-md edit · ${page}`

/**
 * Problems for the view: any accumulated warnings, plus — on the terminal
 * `Error` — a problems-first CRITICAL so the most blocking outcome reads loudest
 * (the dim `failed · <msg>` summary and the `✗` stage row stay as-is). Generic
 * failures carry no fabricated fix, just a `cat` inspect hint when the page is
 * known (`cat` takes a pageId; `status` is path-only, so it would not apply here).
 */
const problemsFor = (state: EditState): readonly ProblemItem[] => {
  if (state._tag !== 'Error') return state.warnings
  return [
    ...state.warnings,
    {
      severity: 'critical',
      name: state.page.length === 0 ? 'edit' : state.page,
      status: 'failed',
      details: state.message,
      fixes: state.page.length === 0 ? [] : [`notion-md cat ${state.page}`],
    },
  ]
}

/** Build the dimmed `·`-joined summary line for a terminal state. */
const summaryParts = (state: EditState): readonly string[] => {
  switch (state._tag) {
    case 'Running':
      return ['editing…']
    case 'Success':
      return state.noChange === true
        ? ['no changes']
        : [`pushed${state.titleWritten === true ? ' · title' : ''}`, state.page]
    case 'Conflict':
      return ['1 page', 'conflict draft written', '0 pushed']
    case 'Error':
      return ['failed', state.message]
  }
}

/**
 * Render the `edit` command output through the shared `/sk-cli-design` kit: the
 * conflict / auto-merge WARNING comes through `problems` (with an actionable
 * `fix:`), the staged write progress through `stages`, and the outcome through
 * the dimmed summary line. All glyph/color/stream choices flow through the active
 * OutputMode, so a pipe gets clean JSON/log and a TTY gets the live render.
 */
export const EditView = ({ stateAtom }: EditViewProps): React.ReactElement => {
  const state = useTuiAtomValue(stateAtom)
  return (
    <CommandOutput
      context={contextLine(state.page)}
      problems={problemsFor(state)}
      sections={[]}
      stages={state.stages}
      summary={summaryParts(state)}
    />
  )
}
