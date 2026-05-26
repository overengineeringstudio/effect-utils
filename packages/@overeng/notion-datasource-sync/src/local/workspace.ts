import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { Effect, Layer, Schema, Stream } from 'effect'

import {
  AbsolutePath,
  Hash,
  MaterializeResult,
  OwnWriteSuppressionToken,
  PageId,
  WorkspaceRelativePath,
  type Hash as HashType,
  type LocalArtifactObservation as LocalArtifactObservationType,
  type MaterializePlan,
  type OwnWriteSuppressionToken as OwnWriteSuppressionTokenType,
  type PageId as PageIdType,
  type PathClaimResult,
  type PathClaimPlan,
  type WorkspaceRelativePath as WorkspaceRelativePathType,
} from '../core/domain.ts'
import { LocalStoreError } from '../core/errors.ts'
import type { GuardName } from '../core/guards.ts'
import { LocalWorkspacePort, type LocalWorkspacePortShape } from '../core/ports.ts'

const decode = <TSchema extends Schema.Schema.AnyNoContext>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: unknown
}) => Schema.decodeUnknownSync(schema)(value)

const metadataDirectoryName = '.notion-datasource-sync'
const pageSidecarDirectoryName = 'pages'
const pathClaimsFileName = 'path-claims.json'

/** Controls how workspace body file paths are derived from page titles and IDs. */
export type PathPolicy = {
  readonly strategy: 'title-slug-with-row-id-suffix'
  readonly bodyExtension: '.nmd'
  readonly caseFold: boolean
  readonly unicodeNormalization: 'NFC'
}

/** Top-level sync policy governing schema ownership, deletion behavior, and path derivation. */
export type WorkspacePolicy = {
  readonly schemaOwnership: 'userManaged' | 'appOwned'
  readonly filesystemDelete:
    | { readonly _tag: 'candidateOnly' }
    | { readonly _tag: 'trustedRemoteTrash'; readonly requiresExplicitCommand: boolean }
  readonly pathPolicy: PathPolicy
}

/** Default path policy: lowercase NFC slugs with a row-ID suffix and `.nmd` body extension. */
export const defaultPathPolicy: PathPolicy = {
  strategy: 'title-slug-with-row-id-suffix',
  bodyExtension: '.nmd',
  caseFold: true,
  unicodeNormalization: 'NFC',
}

/** Default workspace policy: user-managed schema, candidate-only filesystem deletes. */
export const defaultWorkspacePolicy: WorkspacePolicy = {
  schemaOwnership: 'userManaged',
  filesystemDelete: { _tag: 'candidateOnly' },
  pathPolicy: defaultPathPolicy,
}

/**
 * Result of validating a candidate workspace-relative path.
 *
 * `allowed` carries the canonicalized path; `blocked` carries the `PathEscapesRoot` guard name
 * and a human-readable reason (control characters, `..` traversal, reserved names, escaping symlinks, etc.).
 */
export type WorkspacePathDecision =
  | {
      readonly _tag: 'allowed'
      readonly path: WorkspaceRelativePathType
    }
  | {
      readonly _tag: 'blocked'
      readonly guard: Extract<GuardName, 'PathEscapesRoot'>
      readonly message: string
    }

const pathEscapesRoot = (message: string): WorkspacePathDecision => ({
  _tag: 'blocked',
  guard: 'PathEscapesRoot',
  message,
})

const generatedTitleSlugMaxLength = 120

const normalizeForPolicy = ({ value, policy }: { readonly value: string; readonly policy: PathPolicy }): string => {
  const unicodeNormalized = policy.unicodeNormalization === 'NFC' ? value.normalize('NFC') : value
  return policy.caseFold === true ? unicodeNormalized.toLocaleLowerCase('en-US') : unicodeNormalized
}

const isDriveAbsolute = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path)
const containsControlCharacter = (value: string): boolean =>
  Array.from(value).some((char) => {
    const codePoint = char.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })
const reservedPathSegments = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

const isReservedPathSegment = (segment: string): boolean => {
  const reservedName = segment.split('.')[0]
  return reservedName !== undefined && reservedPathSegments.has(reservedName)
}

/**
 * Validates and normalizes a raw path string into a safe workspace-relative path.
 *
 * Rejects absolute paths, control characters, dot-traversals, Windows reserved names,
 * and any symlinks that resolve outside `root`. Returns a `WorkspacePathDecision` tagged union
 * rather than throwing, so callers can pattern-match on the outcome.
 */
export const canonicalizeWorkspaceRelativePath = ({
  path,
  policy = defaultPathPolicy,
  symlinkEscapes = [],
}: {
  readonly path: string
  readonly policy?: PathPolicy
  readonly symlinkEscapes?: ReadonlyArray<string>
}): WorkspacePathDecision => {
  const normalizedInput = normalizeForPolicy({ value: path.replaceAll('\\', '/'), policy })
  if (normalizedInput.length === 0) {
    return pathEscapesRoot('Workspace path must not be empty')
  }

  if (normalizedInput.startsWith('/') === true || isDriveAbsolute(path) === true) {
    return pathEscapesRoot('Workspace path must be root-relative')
  }

  if (containsControlCharacter(normalizedInput) === true) {
    return pathEscapesRoot('Workspace path contains a control character')
  }

  const parts = normalizedInput.split('/')
  if (parts.length === 0 || parts.some((part) => part.length === 0) === true) {
    return pathEscapesRoot('Workspace path must not contain empty segments')
  }

  if (parts.some((part) => part === '.' || part === '..') === true) {
    return pathEscapesRoot('Workspace path must not traverse outside the root')
  }

  if (parts.some(isReservedPathSegment) === true) {
    return pathEscapesRoot('Workspace path contains a reserved segment')
  }

  const relativePath = parts.join('/')
  const escapingSymlinks = new Set(
    symlinkEscapes.map((escapePath) =>
      normalizeForPolicy({ value: escapePath.replaceAll('\\', '/'), policy }),
    ),
  )

  for (let index = 1; index <= parts.length; index += 1) {
    if (escapingSymlinks.has(parts.slice(0, index).join('/')) === true) {
      return pathEscapesRoot('Workspace path crosses a symlink that escapes the root')
    }
  }

  return {
    _tag: 'allowed',
    path: decode({ schema: WorkspaceRelativePath, value: relativePath }),
  }
}

/**
 * Converts a Notion page title into a URL-safe lowercase slug (max 120 chars).
 *
 * Non-alphanumeric runs become single hyphens; leading/trailing hyphens are trimmed.
 * Returns `"untitled"` for blank or all-punctuation titles.
 */
export const titleSlug = (title: string): string => {
  const slug = title
    .normalize('NFC')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, generatedTitleSlugMaxLength)
    .replace(/-+$/g, '')

  return slug.length > 0 ? slug : 'untitled'
}

/**
 * Derives the workspace-relative body file path for a database row using
 * `<title-slug>--<pageId><extension>` under the active `PathPolicy`.
 */
export const bodyPathForRow = ({
  title,
  pageId,
  policy = defaultPathPolicy,
}: {
  readonly title: string
  readonly pageId: PageIdType
  readonly policy?: PathPolicy
}): WorkspacePathDecision =>
  canonicalizeWorkspaceRelativePath({
    path: `${titleSlug(title)}--${pageId}${policy.bodyExtension}`,
    policy,
  })

/**
 * Describes a workspace file that is a candidate for deletion.
 *
 * `remoteTrash` is always `'blocked-by-default'` until an explicit remote-trash policy is active,
 * preventing accidental Notion page trashing from a local delete.
 */
export type LocalDeleteClassification = {
  readonly _tag: 'local-delete-candidate'
  readonly pageId: PageIdType
  readonly path: WorkspaceRelativePathType
  readonly remoteTrash: 'blocked-by-default'
}

/** Builds a `LocalDeleteClassification` for a page that has been removed locally, with remote trash blocked by default. */
export const classifyLocalDelete = ({
  pageId,
  path,
}: {
  readonly pageId: PageIdType
  readonly path: WorkspaceRelativePathType
}): LocalDeleteClassification => ({
  _tag: 'local-delete-candidate',
  pageId,
  path,
  remoteTrash: 'blocked-by-default',
})

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

const sha256Hash = (value: string): HashType =>
  decode({ schema: Hash, value: `sha256:${createHash('sha256').update(value).digest('hex')}` })

const observedAtNow = () => decode({ schema: Schema.DateTimeUtc, value: new Date().toISOString() })

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

const FilesystemPathClaim = Schema.Struct({
  pageId: PageId,
  path: WorkspaceRelativePath,
}).annotations({ identifier: 'NotionDatasourceSync.FilesystemPathClaim' })
type FilesystemPathClaim = typeof FilesystemPathClaim.Type

const FilesystemPathClaims = Schema.Array(FilesystemPathClaim).annotations({
  identifier: 'NotionDatasourceSync.FilesystemPathClaims',
})

/** Construction input for a filesystem-backed `LocalWorkspacePort`: absolute workspace root and optional policy overrides. */
export type FilesystemLocalWorkspaceInput = {
  readonly root: AbsolutePath
  readonly policy?: WorkspacePolicy
}

/** Returns the absolute filesystem path for a page's JSON sidecar file under the workspace metadata directory. */
export const filesystemWorkspacePageSidecarPath = ({
  root,
  pageId,
}: {
  readonly root: AbsolutePath
  readonly pageId: PageIdType
}): string =>
  join(root, metadataDirectoryName, pageSidecarDirectoryName, `${encodeURIComponent(pageId)}.json`)

const pathClaimsPath = (root: AbsolutePath): string =>
  join(root, metadataDirectoryName, pathClaimsFileName)

const localStoreError = ({
  operation,
  message,
  cause,
}: {
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}) =>
  new LocalStoreError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const canonicalRoot = async ({ root, operation }: { readonly root: AbsolutePath; readonly operation: string }): Promise<string> => {
  if (isAbsolute(root) === false) {
    throw localStoreError({ operation, message: 'Workspace root must be absolute' })
  }

  try {
    await mkdir(root, { recursive: true })
    return await realpath(root)
  } catch (cause) {
    throw localStoreError({ operation, message: `Unable to open workspace root ${root}`, cause })
  }
}

const isInside = ({ root, path }: { readonly root: string; readonly path: string }): boolean =>
  path === root || path.startsWith(`${root}${sep}`)

const safeWorkspacePath = async ({
  root,
  rootRealPath,
  path,
  policy,
  operation,
}: {
  readonly root: AbsolutePath
  readonly rootRealPath: string
  readonly path: WorkspaceRelativePathType
  readonly policy: PathPolicy
  readonly operation: string
}): Promise<{
  readonly relativePath: WorkspaceRelativePathType
  readonly absolutePath: string
}> => {
  const decision = canonicalizeWorkspaceRelativePath({ path, policy })
  if (decision._tag === 'blocked') {
    throw localStoreError({ operation, message: decision.message })
  }

  const absolutePath = resolve(rootRealPath, decision.path)
  if (isInside({ root: rootRealPath, path: absolutePath }) === false) {
    throw localStoreError({
      operation,
      message: 'Workspace path resolves outside the root',
    })
  }

  const segments = decision.path.split('/')
  const candidates = segments.map((_, index) => join(root, ...segments.slice(0, index + 1)))
  const inspectedCandidates = await Promise.all(
    candidates.map(async (candidate) => {
      const stats = await lstat(candidate).catch((cause: unknown) => {
        if (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === 'ENOENT'
        ) {
          return undefined
        }
        throw localStoreError({
          operation,
          message: `Unable to inspect workspace path ${candidate}`,
          cause,
        })
      })

      return { candidate, stats }
    }),
  )
  await Promise.all(
    inspectedCandidates.map(async ({ candidate, stats }) => {
      if (stats?.isSymbolicLink() !== true) return

      const target = await realpath(candidate).catch((cause: unknown) => {
        throw localStoreError({
          operation,
          message: `Workspace symlink cannot be resolved: ${decision.path}`,
          cause,
        })
      })
      if (isInside({ root: rootRealPath, path: target }) === false) {
        throw localStoreError({
          operation,
          message: 'Workspace path crosses a symlink that escapes the root',
        })
      }
    }),
  )

  return { relativePath: decision.path, absolutePath }
}

const readJsonFile = async <TSchema extends Schema.Schema.AnyNoContext>({
  schema,
  path,
  operation,
  damageMessage,
}: {
  readonly schema: TSchema
  readonly path: string
  readonly operation: string
  readonly damageMessage: string
}): Promise<typeof schema.Type> => {
  try {
    return decode({ schema, value: JSON.parse(await readFile(path, 'utf8')) })
  } catch (cause) {
    throw localStoreError({ operation, message: `${damageMessage}: ${path}`, cause })
  }
}

const writeJsonFile = async ({ path, value }: { readonly path: string; readonly value: unknown }): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

const writeTextFileAtomic = async ({ path, content }: { readonly path: string; readonly content: string }): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporaryPath, content, 'utf8')
    await rename(temporaryPath, path)
  } catch (cause) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw cause
  }
}

const readPathClaims = async ({
  root,
  operation,
}: {
  readonly root: AbsolutePath
  readonly operation: string
}): Promise<ReadonlyArray<FilesystemPathClaim>> => {
  const claimsPath = pathClaimsPath(root)
  try {
    return await readJsonFile({
      schema: FilesystemPathClaims,
      path: claimsPath,
      operation,
      damageMessage: 'Workspace path claim sidecar is damaged',
    })
  } catch (cause) {
    if (cause instanceof LocalStoreError === false) {
      throw cause
    }
    if (
      'cause' in cause &&
      typeof cause.cause === 'object' &&
      cause.cause !== null &&
      'code' in cause.cause &&
      cause.cause.code === 'ENOENT'
    ) {
      return []
    }
    throw cause
  }
}

const writePathClaims = async ({
  root,
  claims,
}: {
  readonly root: AbsolutePath
  readonly claims: ReadonlyArray<FilesystemPathClaim>
}): Promise<void> => writeJsonFile({ path: pathClaimsPath(root), value: claims })

const readFilesystemSidecars = async ({
  root,
  operation,
}: {
  readonly root: AbsolutePath
  readonly operation: string
}): Promise<ReadonlyArray<FilesystemWorkspaceSidecar>> => {
  const sidecarDirectory = join(root, metadataDirectoryName, pageSidecarDirectoryName)
  const entries = await readdir(sidecarDirectory, { withFileTypes: true }).catch(
    (cause: unknown) => {
      if (
        typeof cause === 'object' &&
        cause !== null &&
        'code' in cause &&
        cause.code === 'ENOENT'
      ) {
        return []
      }
      throw localStoreError({ operation, message: 'Unable to read workspace sidecars', cause })
    },
  )

  const sidecars = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) =>
        readJsonFile({
          schema: FilesystemWorkspaceSidecar,
          path: join(sidecarDirectory, entry.name),
          operation,
          damageMessage: 'Workspace page sidecar is damaged',
        }),
      ),
  )

  const seenPaths = new Map<WorkspaceRelativePathType, FilesystemWorkspaceSidecar>()
  for (const sidecar of sidecars) {
    const existing = seenPaths.get(sidecar.path)
    if (existing !== undefined) {
      throw localStoreError({
        operation,
        message: `Workspace page sidecars conflict for path ${sidecar.path}: ${existing.pageId} and ${sidecar.pageId}`,
      })
    }
    seenPaths.set(sidecar.path, sidecar)
  }

  return sidecars
}

const materializedBodyPlaceholder = ({
  pageId,
  bodyHash,
}: {
  readonly pageId: PageIdType
  readonly bodyHash: HashType
}): string =>
  [
    '<!--',
    'notion-datasource-sync body materialization placeholder',
    `page_id: ${pageId}`,
    `body_hash: ${bodyHash}`,
    '-->',
    '',
  ].join('\n')

const upsertClaim = ({
  claims,
  claim,
}: {
  readonly claims: ReadonlyArray<FilesystemPathClaim>
  readonly claim: FilesystemPathClaim
}): ReadonlyArray<FilesystemPathClaim> => [
  ...claims.filter((existing) => existing.pageId !== claim.pageId),
  claim,
]

const pathClaimConflict = ({
  pageId,
  path,
  sidecars,
  claims,
}: {
  readonly pageId: PageIdType
  readonly path: WorkspaceRelativePathType
  readonly sidecars: ReadonlyArray<FilesystemWorkspaceSidecar>
  readonly claims: ReadonlyArray<FilesystemPathClaim>
}): PageIdType | undefined => {
  const sidecarConflict = sidecars.find(
    (sidecar) => sidecar.path === path && sidecar.pageId !== pageId,
  )
  if (sidecarConflict !== undefined) return sidecarConflict.pageId

  return claims.find((claim) => claim.path === path && claim.pageId !== pageId)?.pageId
}

const assertSafeMaterializeTarget = async ({
  absolutePath,
  relativePath,
  pageId,
  targetContentHash,
  sidecars,
  claims,
}: {
  readonly absolutePath: string
  readonly relativePath: WorkspaceRelativePathType
  readonly pageId: PageIdType
  readonly targetContentHash: HashType
  readonly sidecars: ReadonlyArray<FilesystemWorkspaceSidecar>
  readonly claims: ReadonlyArray<FilesystemPathClaim>
}): Promise<void> => {
  const stats = await lstat(absolutePath).catch((cause: unknown) => {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT') {
      return undefined
    }
    throw localStoreError({
      operation: 'materialize',
      message: `Unable to inspect workspace body file ${relativePath}`,
      cause,
    })
  })
  if (stats === undefined) return

  if (stats.isFile() === false) {
    throw localStoreError({
      operation: 'materialize',
      message: `Workspace path collision requires repair before materialize: ${relativePath}`,
    })
  }

  const samePageSidecar = sidecars.find(
    (sidecar) => sidecar.path === relativePath && sidecar.pageId === pageId,
  )
  const samePageClaim = claims.find(
    (claim) => claim.path === relativePath && claim.pageId === pageId,
  )
  if (samePageSidecar === undefined && samePageClaim === undefined) {
    throw localStoreError({
      operation: 'materialize',
      message: `Workspace path collision has no sidecar or claim identity: ${relativePath}`,
    })
  }

  const existingContent = await readFile(absolutePath, 'utf8').catch((cause: unknown) => {
    throw localStoreError({
      operation: 'materialize',
      message: `Unable to read workspace body file ${relativePath}`,
      cause,
    })
  })
  const existingContentHash = sha256Hash(existingContent)
  if (existingContentHash === targetContentHash) return
  if (
    samePageSidecar !== undefined &&
    existingContentHash === samePageSidecar.materializedContentHash
  ) {
    return
  }

  throw localStoreError({
    operation: 'materialize',
    message: `Workspace body file has local edits; repair required before materialize: ${relativePath}`,
  })
}

const scanFilesystemWorkspace = async ({
  root,
  policy,
}: {
  readonly root: AbsolutePath
  readonly policy: WorkspacePolicy
}): Promise<ReadonlyArray<LocalArtifactObservationType>> => {
  const rootRealPath = await canonicalRoot({ root, operation: 'scan' })
  const sidecars = await readFilesystemSidecars({ root, operation: 'scan' })
  const sidecarByPath = new Map(sidecars.map((sidecar) => [sidecar.path, sidecar]))

  const scanDirectory = async (
    directory: string,
  ): Promise<ReadonlyArray<LocalArtifactObservationType>> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((cause: unknown) => {
      throw localStoreError({
        operation: 'scan',
        message: `Unable to scan workspace directory ${directory}`,
        cause,
      })
    })

    const observations = await Promise.all(
      entries.map(async (entry): Promise<ReadonlyArray<LocalArtifactObservationType>> => {
        const absolutePath = join(directory, entry.name)
        if (
          absolutePath === join(root, metadataDirectoryName) ||
          entry.name === metadataDirectoryName
        ) {
          return []
        }

        const stats = await lstat(absolutePath).catch((cause: unknown) => {
          throw localStoreError({
            operation: 'scan',
            message: `Unable to inspect workspace path ${absolutePath}`,
            cause,
          })
        })

        if (stats.isSymbolicLink() === true) {
          const target = await realpath(absolutePath).catch((cause: unknown) => {
            throw localStoreError({
              operation: 'scan',
              message: `Workspace symlink cannot be resolved: ${absolutePath}`,
              cause,
            })
          })
          if (isInside({ root: rootRealPath, path: target }) === false) {
            throw localStoreError({
              operation: 'scan',
              message: 'Workspace path crosses a symlink that escapes the root',
            })
          }
          return []
        }

        if (stats.isDirectory() === true) {
          return scanDirectory(absolutePath)
        }

        if (
          stats.isFile() === false ||
          entry.name.endsWith(policy.pathPolicy.bodyExtension) === false
        ) {
          return []
        }

        const rawRelativePath = relative(rootRealPath, absolutePath).replaceAll(sep, '/')
        const decision = canonicalizeWorkspaceRelativePath({
          path: rawRelativePath,
          policy: policy.pathPolicy,
        })
        if (decision._tag === 'blocked') {
          throw localStoreError({ operation: 'scan', message: decision.message })
        }

        const sidecar = sidecarByPath.get(decision.path)
        if (sidecar === undefined) {
          throw localStoreError({
            operation: 'scan',
            message: `Workspace body file is missing sidecar identity: ${decision.path}`,
          })
        }

        const content = await readFile(absolutePath, 'utf8').catch((cause: unknown) => {
          throw localStoreError({
            operation: 'scan',
            message: `Unable to read workspace body file ${decision.path}`,
            cause,
          })
        })
        const contentHash = sha256Hash(content)
        const ownWriteSuppressed = contentHash === sidecar.materializedContentHash
        return [
          {
            _tag: 'LocalArtifactObservation',
            pageId: sidecar.pageId,
            path: sidecar.path,
            contentHash: ownWriteSuppressed === true ? sidecar.bodyHash : contentHash,
            observedAt: observedAtNow(),
            state: 'present',
            ...(ownWriteSuppressed === true
              ? { ownWriteSuppressionToken: sidecar.ownWriteSuppressionToken }
              : {}),
          },
        ]
      }),
    )

    return observations.flat()
  }

  const presentObservations = await scanDirectory(rootRealPath)
  const seenSidecarPageIds = new Set(presentObservations.map((observation) => observation.pageId))
  const deleteCandidateObservations = await Promise.all(
    sidecars.map(async (sidecar): Promise<LocalArtifactObservationType | undefined> => {
      if (seenSidecarPageIds.has(sidecar.pageId) === true) return undefined
      const { absolutePath } = await safeWorkspacePath({
        root,
        rootRealPath,
        path: sidecar.path,
        policy: policy.pathPolicy,
        operation: 'scan',
      })
      const exists = await lstat(absolutePath)
        .then(() => true)
        .catch((cause: unknown) => {
          if (
            typeof cause === 'object' &&
            cause !== null &&
            'code' in cause &&
            cause.code === 'ENOENT'
          ) {
            return false
          }
          throw localStoreError({
            operation: 'scan',
            message: `Unable to inspect workspace body file ${sidecar.path}`,
            cause,
          })
        })
      if (exists === false) {
        return {
          _tag: 'LocalArtifactObservation',
          pageId: sidecar.pageId,
          path: sidecar.path,
          contentHash: sidecar.bodyHash,
          observedAt: observedAtNow(),
          state: 'delete-candidate',
        }
      }
      return undefined
    }),
  )

  return [
    ...presentObservations,
    ...deleteCandidateObservations.filter((observation) => observation !== undefined),
  ]
}

/**
 * Creates a `LocalWorkspacePortShape` backed by the real filesystem.
 *
 * Implements `scan` (recursive directory walk with sidecar correlation),
 * `claimPath` (conflict-checked path reservation), and `materialize`
 * (atomic placeholder write + sidecar + path-claims update).
 * All operations resolve symlinks and reject paths that escape the workspace root.
 */
export const makeFilesystemLocalWorkspacePort = ({
  root,
  policy = defaultWorkspacePolicy,
}: FilesystemLocalWorkspaceInput): LocalWorkspacePortShape => ({
  scan: (scanRoot) =>
    Stream.fromEffect(
      Effect.tryPromise({
        try: () => scanFilesystemWorkspace({ root: scanRoot, policy }),
        catch: (cause) =>
          cause instanceof LocalStoreError
            ? cause
            : localStoreError({ operation: 'scan', message: 'Unable to scan workspace', cause }),
      }),
    ).pipe(Stream.flatMap((observations) => Stream.fromIterable(observations))),
  claimPath: (claim) =>
    Effect.tryPromise({
      try: async () => {
        const rootRealPath = await canonicalRoot({ root, operation: 'claimPath' })
        const { relativePath } = await safeWorkspacePath({
          root,
          rootRealPath,
          path: claim.path,
          policy: policy.pathPolicy,
          operation: 'claimPath',
        })
        const sidecars = await readFilesystemSidecars({ root, operation: 'claimPath' })
        const claims = await readPathClaims({ root, operation: 'claimPath' })
        const existingPageId = pathClaimConflict({
          pageId: claim.pageId,
          path: relativePath,
          sidecars,
          claims,
        })
        if (existingPageId !== undefined) {
          return {
            _tag: 'conflict',
            pageId: claim.pageId,
            requestedPath: relativePath,
            existingPageId,
          } satisfies PathClaimResult
        }

        await writePathClaims({
          root,
          claims: upsertClaim({ claims, claim: { pageId: claim.pageId, path: relativePath } }),
        })
        return {
          _tag: 'claimed',
          pageId: claim.pageId,
          path: relativePath,
        } satisfies PathClaimResult
      },
      catch: (cause) =>
        cause instanceof LocalStoreError
          ? cause
          : localStoreError({
              operation: 'claimPath',
              message: 'Unable to claim workspace path',
              cause,
            }),
    }),
  materialize: (plan) =>
    Effect.tryPromise({
      try: async () => {
        const rootRealPath = await canonicalRoot({ root, operation: 'materialize' })
        const { relativePath, absolutePath } = await safeWorkspacePath({
          root,
          rootRealPath,
          path: plan.path,
          policy: policy.pathPolicy,
          operation: 'materialize',
        })
        const sidecars = await readFilesystemSidecars({ root, operation: 'materialize' })
        const claims = await readPathClaims({ root, operation: 'materialize' })
        const existingPageId = pathClaimConflict({
          pageId: plan.pageId,
          path: relativePath,
          sidecars,
          claims,
        })
        if (existingPageId !== undefined) {
          throw localStoreError({
            operation: 'materialize',
            message: `Workspace path is already claimed by page ${existingPageId}`,
          })
        }

        const content = materializedBodyPlaceholder({
          pageId: plan.pageId,
          bodyHash: plan.bodyPointer.bodyHash,
        })
        const materializedContentHash = sha256Hash(content)
        const token = ownWriteSuppressionToken({
          pageId: plan.pageId,
          path: relativePath,
          bodyHash: plan.bodyPointer.bodyHash,
        })
        const sidecar: FilesystemWorkspaceSidecar = {
          version: 1,
          pageId: plan.pageId,
          path: relativePath,
          bodyHash: plan.bodyPointer.bodyHash,
          materializedContentHash,
          ownWriteSuppressionToken: token,
          observedAt: new Date().toISOString(),
        }

        await assertSafeMaterializeTarget({
          absolutePath,
          relativePath,
          pageId: plan.pageId,
          targetContentHash: materializedContentHash,
          sidecars,
          claims,
        })
        await writeTextFileAtomic({ path: absolutePath, content })
        await writeJsonFile({
          path: filesystemWorkspacePageSidecarPath({ root, pageId: plan.pageId }),
          value: sidecar,
        })
        await writePathClaims({
          root,
          claims: upsertClaim({ claims, claim: { pageId: plan.pageId, path: relativePath } }),
        })

        return decode({
          schema: MaterializeResult,
          value: {
            _tag: 'MaterializeResult',
            pageId: plan.pageId,
            path: relativePath,
            bodyHash: plan.bodyPointer.bodyHash,
            ownWriteSuppressionToken: token,
          },
        })
      },
      catch: (cause) =>
        cause instanceof LocalStoreError
          ? cause
          : localStoreError({
              operation: 'materialize',
              message: 'Unable to materialize workspace body',
              cause,
            }),
    }),
})

/** Effect `Layer` that provides `LocalWorkspacePort` backed by the real filesystem. */
export const filesystemLocalWorkspacePortLayer = (input: FilesystemLocalWorkspaceInput) =>
  Layer.succeed(LocalWorkspacePort, makeFilesystemLocalWorkspacePort(input))

/** Seed data for the in-memory fake `LocalWorkspacePort` used in unit tests. */
export type FakeLocalWorkspaceInput = {
  readonly observations?: ReadonlyArray<LocalArtifactObservationType>
  readonly claimedPaths?: ReadonlyArray<PathClaimPlan>
  readonly symlinkEscapes?: ReadonlyArray<string>
  readonly policy?: WorkspacePolicy
}

/**
 * Creates an in-memory `LocalWorkspacePortShape` for use in unit tests.
 *
 * `scan` returns the pre-seeded observations; `claimPath` and `materialize` validate
 * path safety against the supplied policy and detect conflicts in an in-memory map,
 * without touching the filesystem.
 */
export const makeFakeLocalWorkspacePort = ({
  observations = [],
  claimedPaths = [],
  symlinkEscapes = [],
  policy = defaultWorkspacePolicy,
}: FakeLocalWorkspaceInput = {}): LocalWorkspacePortShape => {
  const claims = new Map<WorkspaceRelativePathType, PageIdType>(
    claimedPaths.map((claim) => [claim.path, claim.pageId]),
  )

  return {
    scan: (root) => {
      decode({ schema: AbsolutePath, value: root })
      return Stream.fromIterable(observations)
    },
    claimPath: (claim) => {
      const pathDecision = canonicalizeWorkspaceRelativePath({
        path: claim.path,
        policy: policy.pathPolicy,
        symlinkEscapes,
      })
      if (pathDecision._tag === 'blocked') {
        return Effect.fail(
          new LocalStoreError({
            operation: 'claimPath',
            message: pathDecision.message,
          }),
        )
      }

      const existingPageId = claims.get(pathDecision.path)
      if (existingPageId !== undefined && existingPageId !== claim.pageId) {
        const result: PathClaimResult = {
          _tag: 'conflict',
          pageId: claim.pageId,
          requestedPath: pathDecision.path,
          existingPageId,
        }
        return Effect.succeed(result)
      }

      claims.set(pathDecision.path, claim.pageId)
      const result: PathClaimResult = {
        _tag: 'claimed',
        pageId: claim.pageId,
        path: pathDecision.path,
      }
      return Effect.succeed(result)
    },
    materialize: (plan: MaterializePlan) => {
      const token = ownWriteSuppressionToken({
        pageId: plan.pageId,
        path: plan.path,
        bodyHash: plan.bodyPointer.bodyHash,
      })
      const result = decode({
        schema: MaterializeResult,
        value: {
          _tag: 'MaterializeResult',
          pageId: plan.pageId,
          path: plan.path,
          bodyHash: plan.bodyPointer.bodyHash,
          ownWriteSuppressionToken: token,
        },
      })
      return Effect.succeed(result)
    },
  }
}

/** Effect `Layer` that provides `LocalWorkspacePort` backed by the in-memory fake (for tests). */
export const fakeLocalWorkspacePortLayer = (input?: FakeLocalWorkspaceInput) =>
  Layer.succeed(LocalWorkspacePort, makeFakeLocalWorkspacePort(input))

/** Convenience constructor that builds a `LocalArtifactObservation` in the `present` state from the supplied fields. */
export const presentArtifactObservation = (
  input: Omit<LocalArtifactObservationType, '_tag' | 'state'>,
): LocalArtifactObservationType => ({
  _tag: 'LocalArtifactObservation',
  ...input,
  state: 'present',
})
