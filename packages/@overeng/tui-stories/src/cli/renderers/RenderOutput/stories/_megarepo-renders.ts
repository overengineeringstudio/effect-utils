/**
 * Pre-rendered megarepo output for realistic story fixtures.
 *
 * Imports real megarepo View components and renders them via renderToString
 * so the Storybook preview shows actual colored TUI output.
 *
 * Uses lazy initialization to avoid top-level await (which breaks Storybook's
 * CSF static analyzer).
 */

import { Atom } from '@effect-atom/atom'

// @ts-expect-error
import { ExecView } from '@overeng/megarepo/src/cli/renderers/ExecOutput/mod.ts'
// @ts-expect-error
import * as execFixtures from '@overeng/megarepo/src/cli/renderers/ExecOutput/stories/_fixtures.ts'
/* Deep workspace imports — stories only, not runtime. */
// @ts-expect-error -- deep workspace import not in megarepo's package exports
import { StatusView } from '@overeng/megarepo/src/cli/renderers/StatusOutput/mod.ts'
// @ts-expect-error
import * as statusFixtures from '@overeng/megarepo/src/cli/renderers/StatusOutput/stories/_fixtures.ts'
// @ts-expect-error
import { StoreView } from '@overeng/megarepo/src/cli/renderers/StoreOutput/mod.ts'
// @ts-expect-error
import * as storeFixtures from '@overeng/megarepo/src/cli/renderers/StoreOutput/stories/_fixtures.ts'

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
