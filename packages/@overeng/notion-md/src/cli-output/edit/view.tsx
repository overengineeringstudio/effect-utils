import { type Atom } from '@effect-atom/atom'
import React from 'react'

import { CommandOutput, useTuiAtomValue } from '@overeng/tui-react'

import type { EditState } from './schema.ts'

/** Props for {@link EditView}. */
export interface EditViewProps {
  readonly stateAtom: Atom.Atom<EditState>
}

/** Context header line for the `edit` output (`notion-md edit · <page>`). */
const contextLine = (page: string): string =>
  page.length === 0 ? 'notion-md edit' : `notion-md edit · ${page}`

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
      problems={state.warnings}
      sections={[]}
      stages={state.stages}
      summary={summaryParts(state)}
    />
  )
}
