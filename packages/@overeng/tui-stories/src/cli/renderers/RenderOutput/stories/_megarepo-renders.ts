// @ts-nocheck — Resolved by Vite alias (@megarepo-internal → megarepo/src).
// TS --build can't resolve these, but Storybook's Vite build handles them.
/**
 * Pre-rendered megarepo output for realistic story fixtures.
 *
 * Imports real megarepo View components and renders them via renderToString
 * so the Storybook preview shows actual colored TUI output.
 *
 * Uses @megarepo-internal alias (configured in .storybook/main.ts) which
 * Vite resolves to the megarepo source tree at build time.
 */

import { Atom } from '@effect-atom/atom'
import { ExecView } from '@megarepo-internal/cli/renderers/ExecOutput/mod.ts'
import * as execFixtures from '@megarepo-internal/cli/renderers/ExecOutput/stories/_fixtures.ts'
import { StatusView } from '@megarepo-internal/cli/renderers/StatusOutput/mod.ts'
import * as statusFixtures from '@megarepo-internal/cli/renderers/StatusOutput/stories/_fixtures.ts'
import { StoreView } from '@megarepo-internal/cli/renderers/StoreOutput/mod.ts'
import * as storeFixtures from '@megarepo-internal/cli/renderers/StoreOutput/stories/_fixtures.ts'

import { renderViewToLines } from './_render-helper.ts'

/** Cached render results (lazily initialized on first access) */
let _statusLines: string[] | undefined
let _execLines: string[] | undefined
let _storeStatusLines: string[] | undefined

/** Pre-rendered mr status output (with ANSI colors) */
export const getStatusLines = async (): Promise<string[]> => {
  if (_statusLines === undefined) {
    _statusLines = await renderViewToLines({
      View: StatusView,
      stateAtom: Atom.make(statusFixtures.createDefaultState()),
    })
  }
  return _statusLines
}

/** Pre-rendered mr exec --verbose output (with ANSI colors) */
export const getExecLines = async (): Promise<string[]> => {
  if (_execLines === undefined) {
    _execLines = await renderViewToLines({
      View: ExecView,
      stateAtom: Atom.make(execFixtures.createCompleteState({ verbose: true, mode: 'parallel' })),
    })
  }
  return _execLines
}

/** Pre-rendered mr store status output (with ANSI colors, wider) */
export const getStoreStatusLines = async (): Promise<string[]> => {
  if (_storeStatusLines === undefined) {
    _storeStatusLines = await renderViewToLines({
      View: StoreView,
      stateAtom: Atom.make(
        storeFixtures.createStatusState({
          repoCount: 4,
          worktreeCount: 6,
          worktrees: storeFixtures.mixedIssuesWorktrees,
        }),
      ),
      width: 100,
    })
  }
  return _storeStatusLines
}
