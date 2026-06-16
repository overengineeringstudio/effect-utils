import { join } from 'node:path'

import { Schema } from 'effect'

import { sha256Hex } from '@overeng/utils'

import {
  AbsolutePath,
  Hash,
  OwnWriteSuppressionToken,
  PageId,
  WorkspaceRelativePath,
  type Hash as HashType,
  type LocalArtifactObservation as LocalArtifactObservationType,
  type OwnWriteSuppressionToken as OwnWriteSuppressionTokenType,
  type PageId as PageIdType,
  type WorkspaceRelativePath as WorkspaceRelativePathType,
} from '../core/domain.ts'

const decode = <TSchema extends Schema.Schema.AnyNoContext>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: unknown
}) => Schema.decodeUnknownSync(schema)(value)

export const metadataDirectoryName = '.notion-datasource-sync'
export const pageSidecarDirectoryName = 'pages'

/**
 * Derives the own-write suppression token for a materialized body file.
 *
 * The token encodes `pageId`, `bodyHash`, and `path` so the file-watcher can
 * distinguish daemon-originated writes from genuine user edits and suppress
 * spurious outbox entries.
 */
export const ownWriteSuppressionToken = ({
  pageId,
  path,
  bodyHash,
}: {
  readonly pageId: PageIdType
  readonly path: WorkspaceRelativePathType
  readonly bodyHash: HashType
}): OwnWriteSuppressionTokenType =>
  decode({ schema: OwnWriteSuppressionToken, value: `materialize:${pageId}:${bodyHash}:${path}` })

/** Returns `true` when a local observation matches a known daemon-issued write token and should be suppressed. */
export const isOwnWriteObservation = ({
  observation,
  token,
}: {
  readonly observation: LocalArtifactObservationType
  readonly token: OwnWriteSuppressionTokenType
}): boolean => observation.ownWriteSuppressionToken === token

/** Compute a datasource-sync `sha256:` hash for UTF-8 workspace content. */
export const datasourceSyncContentHash = (value: string): HashType =>
  decode({ schema: Hash, value: `sha256:${sha256Hex(value)}` })

/**
 * Persisted JSON sidecar written alongside each materialized body file.
 *
 * Tracks the `pageId`, canonical `path`, `bodyHash`, materialized content hash,
 * own-write suppression token, and observation timestamp so the scan can detect
 * whether a file has been edited by the user since the last materialization.
 */
export const FilesystemWorkspaceSidecar = Schema.Struct({
  version: Schema.Literal(1),
  pageId: PageId,
  path: WorkspaceRelativePath,
  bodyHash: Hash,
  materializedContentHash: Hash,
  ownWriteSuppressionToken: OwnWriteSuppressionToken,
  observedAt: Schema.String,
}).annotations({ identifier: 'NotionDatasourceSync.FilesystemWorkspaceSidecar' })
export type FilesystemWorkspaceSidecar = typeof FilesystemWorkspaceSidecar.Type

export const makeFilesystemWorkspaceSidecar = ({
  pageId,
  path,
  bodyHash,
  materializedContentHash,
  observedAt = new Date().toISOString(),
}: {
  readonly pageId: PageIdType
  readonly path: WorkspaceRelativePathType
  readonly bodyHash: HashType
  readonly materializedContentHash: HashType
  readonly observedAt?: string
}): FilesystemWorkspaceSidecar => ({
  version: 1,
  pageId,
  path,
  bodyHash,
  materializedContentHash,
  ownWriteSuppressionToken: ownWriteSuppressionToken({ pageId, path, bodyHash }),
  observedAt,
})

/** Returns the absolute filesystem path for a page's JSON sidecar file under the workspace metadata directory. */
export const filesystemWorkspacePageSidecarPath = ({
  root,
  pageId,
}: {
  readonly root: AbsolutePath
  readonly pageId: PageIdType
}): string =>
  join(root, metadataDirectoryName, pageSidecarDirectoryName, `${encodeURIComponent(pageId)}.json`)
