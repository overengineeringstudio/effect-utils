/**
 * Atomic file writes for store state.
 *
 * State files under `$STORE/.state/` (liveness records, gc ledger) must never
 * be observed half-written by a concurrent reader. `writeFileAtomic` writes to
 * a sibling temp file and `rename`s it into place — on POSIX filesystems
 * `rename` over an existing path is atomic, so a reader sees either the old or
 * the new content, never a truncated mix.
 */

import { createHash } from 'node:crypto'

import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Effect } from 'effect'

import { EffectPath, type AbsoluteFilePath } from '@overeng/effect-path'

/** Derives a per-target temp path so concurrent writers to distinct targets don't collide. */
const tempPathFor = (path: AbsoluteFilePath): AbsoluteFilePath => {
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 16)
  return EffectPath.unsafe.absoluteFile(`${path}.tmp-${digest}`)
}

/**
 * Atomically write `content` to `path` via write-temp-then-rename.
 *
 * The temp file lives in the same directory as the target (required for
 * `rename` to stay on one filesystem). On any failure the temp file is removed
 * so it never lingers as garbage.
 */
export const writeFileAtomic = ({
  path,
  content,
}: {
  path: AbsoluteFilePath
  content: string
}): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tempPath = tempPathFor(path)
    yield* fs
      .writeFileString(tempPath, content)
      .pipe(Effect.tapError(() => fs.remove(tempPath).pipe(Effect.catchAll(() => Effect.void))))
    yield* fs
      .rename(tempPath, path)
      .pipe(Effect.tapError(() => fs.remove(tempPath).pipe(Effect.catchAll(() => Effect.void))))
  }).pipe(
    Effect.withSpan('megarepo/store/fs/write-atomic', {
      attributes: { 'span.label': 'write-atomic' },
    }),
  )
