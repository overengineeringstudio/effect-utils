import { Result, Schema } from 'effect'

/** Canonical identity of a released record or medium binding; ownership is separate metadata. */
export const RegistryId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^[a-z][a-z0-9-]*\/v[1-9][0-9]*$/),
).annotate({ identifier: 'SchemaRegistry.RegistryId' })
export type RegistryId = typeof RegistryId.Type
/** Released schema contributed by one authority without merging semantic record types. */
export type RegistryFragment = {
  readonly id: string
  /** Existing wire spelling is an alias of this release, not an independent version. */
  readonly wireTag?: string
  readonly schema: Schema.Constraint
}
/** Semantic ownership and independently versioned schema fragments. */
export type RegistryAuthority = {
  readonly id: string
  readonly owner: string
  readonly fragments: ReadonlyArray<RegistryFragment>
}
/** Validated boundary composition retaining each authority and its schema fragments. */
export type RegistryCatalog = {
  readonly authorities: ReadonlyArray<RegistryAuthority>
  readonly fragments: ReadonlyArray<RegistryFragment>
  readonly wireTags: ReadonlyMap<string, RegistryFragment>
}

/** Identifies a fragment whose released id does not match the canonical grammar. */
export class InvalidRegistryIdError extends Schema.TaggedError<InvalidRegistryIdError>()(
  'InvalidRegistryIdError',
  {
    id: Schema.String,
    authority: Schema.String,
    message: Schema.String,
  },
) {}
/** Identifies an ambiguous released id and both authorities claiming it. */
export class DuplicateRegistryIdError extends Schema.TaggedError<DuplicateRegistryIdError>()(
  'DuplicateRegistryIdError',
  {
    id: Schema.String,
    authority: Schema.String,
    previousAuthority: Schema.String,
    message: Schema.String,
  },
) {}
/** Identifies a repeated authority declaration at the composition boundary. */
export class DuplicateAuthorityIdError extends Schema.TaggedError<DuplicateAuthorityIdError>()(
  'DuplicateAuthorityIdError',
  {
    id: Schema.String,
    message: Schema.String,
  },
) {}
/** Invalid wire spelling; aliases are nonempty exact strings, not canonical RegistryIds. */
export class InvalidWireTagError extends Schema.TaggedError<InvalidWireTagError>()(
  'InvalidWireTagError',
  { id: Schema.String, wireTag: Schema.String, message: Schema.String },
) {}
/** Two released records cannot claim the same wire spelling. */
export class DuplicateWireTagError extends Schema.TaggedError<DuplicateWireTagError>()(
  'DuplicateWireTagError',
  {
    wireTag: Schema.String,
    id: Schema.String,
    previousId: Schema.String,
    message: Schema.String,
  },
) {}
/** Closed failure channel for authority and released-schema identity collisions. */
export type RegistryCompositionError =
  | InvalidRegistryIdError
  | DuplicateRegistryIdError
  | DuplicateAuthorityIdError
  | InvalidWireTagError
  | DuplicateWireTagError

/** Captures authority metadata; composition validates the complete boundary, not only one author. */
export const defineAuthority = (authority: RegistryAuthority): RegistryAuthority => ({
  ...authority,
  fragments: authority.fragments.map((fragment) => ({ ...fragment })),
})
/** Validates released identities and rejects duplicate ownership before resolving a registry. */
export const composeRegistry = (input: {
  readonly authorities: ReadonlyArray<RegistryAuthority>
}): Result.Result<RegistryCatalog, RegistryCompositionError> => {
  const authorities = new Set<string>()
  const owners = new Map<string, string>()
  const fragments: Array<RegistryFragment> = []
  const wireTags = new Map<string, RegistryFragment>()
  for (const authority of input.authorities) {
    if (authorities.has(authority.id))
      return Result.fail(
        new DuplicateAuthorityIdError({
          id: authority.id,
          message: `Duplicate authority ${authority.id}`,
        }),
      )
    authorities.add(authority.id)
    for (const fragment of authority.fragments) {
      if (!Schema.is(RegistryId)(fragment.id))
        return Result.fail(
          new InvalidRegistryIdError({
            id: fragment.id,
            authority: authority.id,
            message: `Invalid registry identity ${fragment.id}; expected <name>/v<N>`,
          }),
        )
      const previousAuthority = owners.get(fragment.id)
      if (previousAuthority !== undefined)
        return Result.fail(
          new DuplicateRegistryIdError({
            id: fragment.id,
            authority: authority.id,
            previousAuthority,
            message: `Registry identity ${fragment.id} is owned by both ${previousAuthority} and ${authority.id}`,
          }),
        )
      owners.set(fragment.id, authority.id)
      const wireTag = fragment.wireTag ?? fragment.id
      if (!wireTag || wireTag.trim() !== wireTag)
        return Result.fail(
          new InvalidWireTagError({
            id: fragment.id,
            wireTag,
            message: `Invalid wire tag for ${fragment.id}: expected a nonempty trimmed string`,
          }),
        )
      const previous = wireTags.get(wireTag)
      if (previous !== undefined)
        return Result.fail(
          new DuplicateWireTagError({
            wireTag,
            id: fragment.id,
            previousId: previous.id,
            message: `Wire tag ${wireTag} aliases both ${previous.id} and ${fragment.id}`,
          }),
        )
      wireTags.set(wireTag, fragment)
      fragments.push(fragment)
    }
  }
  return Result.succeed({ authorities: input.authorities, fragments, wireTags })
}
