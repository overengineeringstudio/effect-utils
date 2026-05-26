import { Schema } from 'effect'

import type { Hash, PageId, PropertyId } from './domain.ts'
import type { SurfaceKey } from './events.ts'

/** Discriminator for the type of conflict detected between local and remote changes. */
export const ConflictKind = Schema.Literal(
  'same-property',
  'disjoint-property',
  'property-vs-body',
  'body-body-delegated',
  'delete-vs-edit',
  'schema-affects-property',
  'relation-unavailable',
  'path-collision',
  'lossy-body',
  'permission-ambiguous',
).annotations({ identifier: 'NotionDatasourceSync.ConflictKind' })
export type ConflictKind = typeof ConflictKind.Type

/** A change surface representing a property-value mutation on a specific page; carries base and next hashes for three-way merge. */
export type PropertyChangeSurface = {
  readonly _tag: 'property'
  readonly pageId: PageId
  readonly propertyId: PropertyId
  readonly baseHash: Hash
  readonly nextHash: Hash
  readonly surface: SurfaceKey
}

/** A change surface representing a markdown body mutation; `lossy` is true when the body has a known lossiness condition. */
export type BodyChangeSurface = {
  readonly _tag: 'body'
  readonly pageId: PageId
  readonly baseHash: Hash
  readonly nextHash: Hash
  readonly lossy: boolean
  readonly surface: SurfaceKey
}

/** A change surface representing a data-source schema mutation; lists the affected property IDs so independent properties can be excluded. */
export type SchemaChangeSurface = {
  readonly _tag: 'schema'
  readonly affectedPropertyIds: ReadonlyArray<PropertyId>
  readonly surface: SurfaceKey
}

/** A change surface representing a page deletion or trash operation; always conflicts with any concurrent edit. */
export type DeleteChangeSurface = {
  readonly _tag: 'delete'
  readonly pageId: PageId
  readonly surface: SurfaceKey
}

/** A change surface representing a path-claim attempt; carries the existing page ID when a collision is detected. */
export type PathClaimChangeSurface = {
  readonly _tag: 'path'
  readonly path: string
  readonly pageId: PageId
  readonly existingPageId: PageId | undefined
  readonly surface: SurfaceKey
}

/** A change surface representing a relation-property update; `available: false` indicates the target page is inaccessible. */
export type RelationAvailabilitySurface = {
  readonly _tag: 'relation'
  readonly pageId: PageId
  readonly propertyId: PropertyId
  readonly available: boolean
  readonly surface: SurfaceKey
}

/** A change surface representing a permission-ambiguous lifecycle event; `ambiguous: true` blocks the operation until permissions are resolved. */
export type PermissionSurface = {
  readonly _tag: 'permission'
  readonly pageId: PageId
  readonly ambiguous: boolean
  readonly surface: SurfaceKey
}

/** Discriminated union of all change-surface types passed to `classifyConflict`; the `_tag` selects the surface kind. */
export type ConflictSurface =
  | PropertyChangeSurface
  | BodyChangeSurface
  | SchemaChangeSurface
  | DeleteChangeSurface
  | PathClaimChangeSurface
  | RelationAvailabilitySurface
  | PermissionSurface

/** Data carried by a `conflict` classification result; includes the conflict kind, surface keys, three-way hashes, and a message. */
export type ConflictPayload = {
  readonly kind: Exclude<ConflictKind, 'disjoint-property' | 'property-vs-body'>
  readonly localSurface: SurfaceKey
  readonly remoteSurface: SurfaceKey
  readonly baseHash: Hash | undefined
  readonly localHash: Hash | undefined
  readonly remoteHash: Hash | undefined
  readonly message: string
}

/**
 * Result of `classifyConflict`: tagged union of `conflict` (requires resolution), `mergeable` (auto-mergeable kind), and `independent` (no overlap).
 */
export type ConflictClassification =
  | {
      readonly _tag: 'conflict'
      readonly conflict: ConflictPayload
    }
  | {
      readonly _tag: 'mergeable'
      readonly kind: 'disjoint-property' | 'property-vs-body'
      readonly localSurface: SurfaceKey
      readonly remoteSurface: SurfaceKey
    }
  | {
      readonly _tag: 'independent'
      readonly localSurface: SurfaceKey
      readonly remoteSurface: SurfaceKey
    }

const conflict = ({
  kind,
  local,
  remote,
  message,
}: {
  readonly kind: ConflictPayload['kind']
  readonly local: ConflictSurface
  readonly remote: ConflictSurface
  readonly message: string
}): ConflictClassification => ({
  _tag: 'conflict',
  conflict: {
    kind,
    localSurface: local.surface,
    remoteSurface: remote.surface,
    baseHash: 'baseHash' in local ? local.baseHash : undefined,
    localHash: 'nextHash' in local ? local.nextHash : undefined,
    remoteHash: 'nextHash' in remote ? remote.nextHash : undefined,
    message,
  },
})

const samePage = (left: { readonly pageId: PageId }, right: { readonly pageId: PageId }) =>
  left.pageId === right.pageId

/**
 * Classifies the relationship between two change surfaces as `conflict`, `mergeable`, or `independent`.
 *
 * Rules (evaluated in priority order): permission ambiguity, path collision, relation unavailability,
 * lossy body, delete-vs-edit, schema-affects-property, same-property, property-vs-body, body-body.
 */
export const classifyConflict = (
  local: ConflictSurface,
  remote: ConflictSurface,
): ConflictClassification => {
  if (local._tag === 'permission' || remote._tag === 'permission') {
    const permission =
      local._tag === 'permission' ? local : remote._tag === 'permission' ? remote : undefined
    if (permission?.ambiguous === true) {
      return conflict({
        kind: 'permission-ambiguous',
        local,
        remote,
        message: 'Page lifecycle or value is permission ambiguous',
      })
    }
  }

  if (local._tag === 'path' || remote._tag === 'path') {
    const path = local._tag === 'path' ? local : remote._tag === 'path' ? remote : undefined
    if (path?.existingPageId !== undefined && path.existingPageId !== path.pageId) {
      return conflict({
        kind: 'path-collision',
        local,
        remote,
        message: 'Two pages claim the same local path',
      })
    }
  }

  if (local._tag === 'relation' || remote._tag === 'relation') {
    const relation =
      local._tag === 'relation' ? local : remote._tag === 'relation' ? remote : undefined
    if (relation?.available === false) {
      return conflict({
        kind: 'relation-unavailable',
        local,
        remote,
        message: 'Relation target is unavailable',
      })
    }
  }

  if (local._tag === 'body' && local.lossy === true) {
    return conflict({ kind: 'lossy-body', local, remote, message: 'Local body surface is lossy' })
  }

  if (remote._tag === 'body' && remote.lossy === true) {
    return conflict({ kind: 'lossy-body', local, remote, message: 'Remote body surface is lossy' })
  }

  if (local._tag === 'delete' || remote._tag === 'delete') {
    return conflict({
      kind: 'delete-vs-edit',
      local,
      remote,
      message: 'Delete/trash conflicts with an edit',
    })
  }

  if (local._tag === 'schema' && remote._tag === 'property') {
    return local.affectedPropertyIds.includes(remote.propertyId) === true
      ? conflict({
          kind: 'schema-affects-property',
          local,
          remote,
          message: 'Schema change affects edited property',
        })
      : { _tag: 'independent', localSurface: local.surface, remoteSurface: remote.surface }
  }

  if (local._tag === 'property' && remote._tag === 'schema') {
    return remote.affectedPropertyIds.includes(local.propertyId) === true
      ? conflict({
          kind: 'schema-affects-property',
          local,
          remote,
          message: 'Schema change affects edited property',
        })
      : { _tag: 'independent', localSurface: local.surface, remoteSurface: remote.surface }
  }

  if (local._tag === 'property' && remote._tag === 'property' && samePage(local, remote)) {
    return local.propertyId === remote.propertyId
      ? conflict({
          kind: 'same-property',
          local,
          remote,
          message: 'Local and remote changed the same property',
        })
      : {
          _tag: 'mergeable',
          kind: 'disjoint-property',
          localSurface: local.surface,
          remoteSurface: remote.surface,
        }
  }

  if (
    ((local._tag === 'property' && remote._tag === 'body') ||
      (local._tag === 'body' && remote._tag === 'property')) &&
    samePage(local, remote)
  ) {
    return {
      _tag: 'mergeable',
      kind: 'property-vs-body',
      localSurface: local.surface,
      remoteSurface: remote.surface,
    }
  }

  if (local._tag === 'body' && remote._tag === 'body' && samePage(local, remote)) {
    return conflict({
      kind: 'body-body-delegated',
      local,
      remote,
      message: 'Body/body merge must be delegated to the body adapter',
    })
  }

  return { _tag: 'independent', localSurface: local.surface, remoteSurface: remote.surface }
}
