import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { Schema } from 'effect'

import { TrimmedNonEmptyString as NonEmptyString } from './primitives.ts'
/** Executable evidence joining semantic fragments to concrete implementation paths. */
export const UsageClaim = Schema.Struct({
  id: NonEmptyString,
  fragmentId: NonEmptyString,
  kind: Schema.Literals([
    'contract-authority',
    'producer',
    'mutator',
    'semantic-consumer',
    'transport-consumer',
  ]),
  implementationPaths: Schema.NonEmptyArray(NonEmptyString),
  surfaces: Schema.NonEmptyArray(NonEmptyString),
  keys: Schema.Array(NonEmptyString),
  dynamicKeyScope: Schema.optional(Schema.Literals(['declared-keys', 'open'])),
  phases: Schema.NonEmptyArray(
    Schema.Literals([
      'materialize',
      'create',
      'reconcile',
      'launch',
      'runtime',
      'author',
      'admission',
    ]),
  ),
  enforcement: Schema.Literals(['advisory', 'constructor', 'mediated']),
  description: NonEmptyString,
}).annotate({ identifier: 'PtyTagSchema.UsageClaim' })
export type UsageClaim = typeof UsageClaim.Type
/** Lists incomplete, unknown, duplicate, or non-existent implementation evidence. */
export class UsageClaimCompletenessError extends Schema.TaggedError<UsageClaimCompletenessError>()(
  'UsageClaimCompletenessError',
  {
    missingFragmentIds: Schema.Array(NonEmptyString),
    unknownFragmentIds: Schema.Array(NonEmptyString),
    duplicateClaimIds: Schema.Array(NonEmptyString),
    missingImplementationPaths: Schema.Array(NonEmptyString),
    message: NonEmptyString,
  },
) {}

/** Proves every nonexempt fragment has unambiguous claims backed by existing implementation paths. */
export const assertFragmentUsageClaims = (args: {
  readonly fragments: ReadonlyArray<{ readonly id: string }>
  readonly claims: ReadonlyArray<UsageClaim>
  readonly exemptFragmentIds?: ReadonlyArray<string>
  readonly repositoryRoot?: string
  readonly message?: string
}): void => {
  const fragmentIds = new Set(args.fragments.map(({ id }) => id))
  const claimedIds = new Set(args.claims.map(({ fragmentId }) => fragmentId))
  const missingFragmentIds = [...fragmentIds]
    .filter((id) => !args.exemptFragmentIds?.includes(id) && !claimedIds.has(id))
    .toSorted()
  const unknownFragmentIds = [...claimedIds].filter((id) => !fragmentIds.has(id)).toSorted()
  const seen = new Set<string>()
  const duplicateClaimIds = args.claims
    .flatMap(({ id }) => (seen.has(id) ? [id] : (seen.add(id), [])))
    .toSorted()
  const repositoryRoot = args.repositoryRoot
  const missingImplementationPaths =
    repositoryRoot === undefined
      ? []
      : [...new Set(args.claims.flatMap(({ implementationPaths }) => implementationPaths))]
          .filter((path) => {
            if (existsSync(resolve(repositoryRoot, path))) return false
            const separator = path.indexOf(':')
            return separator < 0 || !existsSync(resolve(repositoryRoot, path.slice(0, separator)))
          })
          .toSorted()
  if (
    missingFragmentIds.length +
      unknownFragmentIds.length +
      duplicateClaimIds.length +
      missingImplementationPaths.length >
    0
  ) {
    throw new UsageClaimCompletenessError({
      missingFragmentIds,
      unknownFragmentIds,
      duplicateClaimIds,
      missingImplementationPaths,
      message: args.message ?? 'Registry usage claims are incomplete or ambiguous',
    })
  }
}
