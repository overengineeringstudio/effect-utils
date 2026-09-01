import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'

type MemberMountState =
  | { readonly _tag: 'Missing' }
  | { readonly _tag: 'Symlink'; readonly target: string }
  | { readonly _tag: 'Foreign' }

const isInvalidArgumentCause = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EINVAL'

/** Node reports readlink(2) on a real file or directory as EINVAL. */
const isNonSymlinkReadLinkError = (error: PlatformError): boolean =>
  error.reason._tag === 'Unknown' &&
  error.reason.syscall === 'readlink' &&
  isInvalidArgumentCause(error.reason.cause)

/** Inspect a member path without following or mutating it. Unexpected failures remain failures. */
export const inspectMemberMount = (
  path: string,
): Effect.Effect<MemberMountState, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readLink(path).pipe(
      Effect.map((target): MemberMountState => ({ _tag: 'Symlink', target })),
      Effect.catch((error): Effect.Effect<MemberMountState, PlatformError> => {
        if (error.reason._tag === 'NotFound') {
          return Effect.succeed({ _tag: 'Missing' })
        }
        if (isNonSymlinkReadLinkError(error) === true) {
          return Effect.succeed({ _tag: 'Foreign' })
        }
        return Effect.fail(error)
      }),
    )
  })

/** One loud refusal shape for every command that encounters a foreign member mount. */
export const foreignMemberMountMessage = ({
  name,
  path,
  operation,
}: {
  readonly name: string
  readonly path: string
  readonly operation: 'replace' | 'remove' | 'pin' | 'unpin'
}): string =>
  `Refusing to ${operation} member '${name}' at '${path}': it is a foreign non-symlink mount`
