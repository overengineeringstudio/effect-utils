/**
 * Canonical scoped temporary roots for fixtures.
 *
 * Composition refuses non-canonical paths on purpose: R6 identity, owned-worktree
 * acquisition and locked-source admission all require the physical path, because
 * Git reports physical paths and a mount whose identity is a symlink is not the
 * mount that was admitted. Real callers reach those guards through paths Git or
 * the store already resolved, so a fixture rooted at a raw temporary directory
 * is not reproducing what production hands in.
 *
 * On macOS `os.tmpdir()` sits under the `/var` -> `/private/var` symlink, so a
 * raw temporary root is exactly that non-canonical shape and the guards refuse
 * it. Resolve once, here, so every fixture builds its tree the way production
 * does. On a filesystem with no symlink above the temporary directory this is
 * the identity, so Linux behaviour is unchanged.
 *
 * `store-setup.ts`'s `createStoreFixture` already does this inline for the store
 * tree; this is the same rule for fixtures that build their own roots.
 */

import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'

/**
 * Scoped temporary directory resolved to its physical path, without a trailing
 * slash — the same shape `fs.makeTempDirectoryScoped` returns, so call sites
 * keep whatever wrapping they already had.
 */
export const makeCanonicalTempDirectoryScoped = Effect.fn(
  'megarepo/test-utils/canonical-temp-directory',
)(function* () {
  const fs = yield* FileSystem.FileSystem
  const raw = yield* fs.makeTempDirectoryScoped()
  return (yield* fs.realPath(raw)).replace(/\/+$/u, '')
})
