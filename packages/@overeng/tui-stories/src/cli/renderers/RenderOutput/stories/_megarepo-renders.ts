/**
 * Pre-rendered megarepo output for realistic story fixtures.
 *
 * Imports real megarepo View components and renders them via renderToString
 * so the Storybook preview shows actual colored TUI output.
 *
 * Uses relative workspace paths because Vite's production build enforces
 * package exports strictly — deep `@overeng/megarepo/src/...` imports
 * fail in prod even though they work in dev mode.
 */

import { Atom } from '@effect-atom/atom'

import { ExecView } from '../../../../../../../../megarepo/src/cli/renderers/ExecOutput/mod.ts'
import * as execFixtures from '../../../../../../../../megarepo/src/cli/renderers/ExecOutput/stories/_fixtures.ts'
/* Relative workspace imports (stories only, not runtime CLI code) */
import { StatusView } from '../../../../../../../../megarepo/src/cli/renderers/StatusOutput/mod.ts'
import * as statusFixtures from '../../../../../../../../megarepo/src/cli/renderers/StatusOutput/stories/_fixtures.ts'
import { StoreView } from '../../../../../../../../megarepo/src/cli/renderers/StoreOutput/mod.ts'
import * as storeFixtures from '../../../../../../../../megarepo/src/cli/renderers/StoreOutput/stories/_fixtures.ts'
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
