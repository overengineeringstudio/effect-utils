import { type Atom } from '@effect-atom/atom'
import React from 'react'

import { CommandOutput, useTuiAtomValue } from '@overeng/tui-react'

import type { StatusState } from './schema.ts'

/** Props for {@link StatusView}. */
export interface StatusViewProps {
  readonly stateAtom: Atom.Atom<StatusState>
}

/** Context header line for the `status` output (`notion-md status · <target>`). */
const contextLine = (target: string): string =>
  target.length === 0 ? 'notion-md status' : `notion-md status · ${target}`

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
      problems={state._tag === 'Success' ? state.problems : []}
      sections={state._tag === 'Success' ? state.sections : []}
      summary={summaryParts(state)}
    />
  )
}
