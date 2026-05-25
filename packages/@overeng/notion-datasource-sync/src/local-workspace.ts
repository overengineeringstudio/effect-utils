import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
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
} from './domain.ts'
import { LocalStoreError } from './errors.ts'
import type { GuardName } from './guards.ts'
import { LocalWorkspacePort, type LocalWorkspacePortShape } from './ports.ts'

const decode = <TSchema extends Schema.Schema.AnyNoContext>(schema: TSchema, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

const metadataDirectoryName = '.notion-datasource-sync'
const pageSidecarDirectoryName = 'pages'
const pathClaimsFileName = 'path-claims.json'

export type PathPolicy = {
  readonly strategy: 'title-slug-with-row-id-suffix'
  readonly bodyExtension: '.nmd'
  readonly caseFold: boolean
  readonly unicodeNormalization: 'NFC'
}

export type WorkspacePolicy = {
  readonly schemaOwnership: 'userManaged' | 'appOwned'
  readonly filesystemDelete:
    | { readonly _tag: 'candidateOnly' }
    | { readonly _tag: 'trustedRemoteTrash'; readonly requiresExplicitCommand: boolean }
  readonly pathPolicy: PathPolicy
}

export const defaultPathPolicy: PathPolicy = {
  strategy: 'title-slug-with-row-id-suffix',
  bodyExtension: '.nmd',
  caseFold: true,
  unicodeNormalization: 'NFC',
}

export const defaultWorkspacePolicy: WorkspacePolicy = {
  schemaOwnership: 'userManaged',
  filesystemDelete: { _tag: 'candidateOnly' },
  pathPolicy: defaultPathPolicy,
}

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

const normalizeForPolicy = (value: string, policy: PathPolicy): string => {
  const unicodeNormalized = policy.unicodeNormalization === 'NFC' ? value.normalize('NFC') : value
  return policy.caseFold ? unicodeNormalized.toLocaleLowerCase('en-US') : unicodeNormalized
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

export const canonicalizeWorkspaceRelativePath = ({
  path,
  policy = defaultPathPolicy,
  symlinkEscapes = [],
}: {
  readonly path: string
  readonly policy?: PathPolicy
  readonly symlinkEscapes?: ReadonlyArray<string>
}): WorkspacePathDecision => {
  const normalizedInput = normalizeForPolicy(path.replaceAll('\\', '/'), policy)
  if (normalizedInput.length === 0) {
    return pathEscapesRoot('Workspace path must not be empty')
  }

  if (normalizedInput.startsWith('/') || isDriveAbsolute(path)) {
    return pathEscapesRoot('Workspace path must be root-relative')
  }

  if (containsControlCharacter(normalizedInput)) {
    return pathEscapesRoot('Workspace path contains a control character')
  }

  const parts = normalizedInput.split('/')
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    return pathEscapesRoot('Workspace path must not contain empty segments')
  }

  if (parts.some((part) => part === '.' || part === '..')) {
    return pathEscapesRoot('Workspace path must not traverse outside the root')
  }

  if (parts.some(isReservedPathSegment)) {
    return pathEscapesRoot('Workspace path contains a reserved segment')
  }

  const relativePath = parts.join('/')
  const escapingSymlinks = new Set(
    symlinkEscapes.map((escapePath) =>
      normalizeForPolicy(escapePath.replaceAll('\\', '/'), policy),
    ),
  )

  for (let index = 1; index <= parts.length; index += 1) {
    if (escapingSymlinks.has(parts.slice(0, index).join('/'))) {
      return pathEscapesRoot('Workspace path crosses a symlink that escapes the root')
    }
  }

  return {
    _tag: 'allowed',
    path: decode(WorkspaceRelativePath, relativePath),
  }
}

export const titleSlug = (title: string): string => {
  const slug = title
    .normalize('NFC')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug.length > 0 ? slug : 'untitled'
}

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

export type LocalDeleteClassification = {
  readonly _tag: 'local-delete-candidate'
  readonly pageId: PageIdType
  readonly path: WorkspaceRelativePathType
  readonly remoteTrash: 'blocked-by-default'
}

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

export const ownWriteSuppressionToken = ({
  pageId,
  path,
  bodyHash,
}: {
  readonly pageId: PageIdType
  readonly path: WorkspaceRelativePathType
  readonly bodyHash: HashType
}): OwnWriteSuppressionTokenType =>
  decode(OwnWriteSuppressionToken, `materialize:${pageId}:${bodyHash}:${path}`)

export const isOwnWriteObservation = ({
  observation,
  token,
}: {
  readonly observation: LocalArtifactObservationType
  readonly token: OwnWriteSuppressionTokenType
}): boolean => observation.ownWriteSuppressionToken === token

const sha256Hash = (value: string): HashType =>
  decode(Hash, `sha256:${createHash('sha256').update(value).digest('hex')}`)

const observedAtNow = () => decode(Schema.DateTimeUtc, new Date().toISOString())

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

export type FilesystemLocalWorkspaceInput = {
  readonly root: AbsolutePath
  readonly policy?: WorkspacePolicy
}

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

const canonicalRoot = async (root: AbsolutePath, operation: string): Promise<string> => {
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

const isInside = (root: string, path: string): boolean =>
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
  if (isInside(rootRealPath, absolutePath) === false) {
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
      if (isInside(rootRealPath, target) === false) {
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
    return decode(schema, JSON.parse(await readFile(path, 'utf8')))
  } catch (cause) {
    throw localStoreError({ operation, message: `${damageMessage}: ${path}`, cause })
  }
}

const writeJsonFile = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

const readPathClaims = async (
  root: AbsolutePath,
  operation: string,
): Promise<ReadonlyArray<FilesystemPathClaim>> => {
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

const writePathClaims = async (
  root: AbsolutePath,
  claims: ReadonlyArray<FilesystemPathClaim>,
): Promise<void> => writeJsonFile(pathClaimsPath(root), claims)

const readFilesystemSidecars = async (
  root: AbsolutePath,
  operation: string,
): Promise<ReadonlyArray<FilesystemWorkspaceSidecar>> => {
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

  return Promise.all(
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

const upsertClaim = (
  claims: ReadonlyArray<FilesystemPathClaim>,
  claim: FilesystemPathClaim,
): ReadonlyArray<FilesystemPathClaim> => [
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

const scanFilesystemWorkspace = async ({
  root,
  policy,
}: {
  readonly root: AbsolutePath
  readonly policy: WorkspacePolicy
}): Promise<ReadonlyArray<LocalArtifactObservationType>> => {
  const rootRealPath = await canonicalRoot(root, 'scan')
  const sidecars = await readFilesystemSidecars(root, 'scan')
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

        if (stats.isSymbolicLink()) {
          const target = await realpath(absolutePath).catch((cause: unknown) => {
            throw localStoreError({
              operation: 'scan',
              message: `Workspace symlink cannot be resolved: ${absolutePath}`,
              cause,
            })
          })
          if (isInside(rootRealPath, target) === false) {
            throw localStoreError({
              operation: 'scan',
              message: 'Workspace path crosses a symlink that escapes the root',
            })
          }
          return []
        }

        if (stats.isDirectory()) {
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
            contentHash: ownWriteSuppressed ? sidecar.bodyHash : contentHash,
            observedAt: observedAtNow(),
            state: 'present',
            ...(ownWriteSuppressed
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
      if (seenSidecarPageIds.has(sidecar.pageId)) return undefined
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
        const rootRealPath = await canonicalRoot(root, 'claimPath')
        const { relativePath } = await safeWorkspacePath({
          root,
          rootRealPath,
          path: claim.path,
          policy: policy.pathPolicy,
          operation: 'claimPath',
        })
        const sidecars = await readFilesystemSidecars(root, 'claimPath')
        const claims = await readPathClaims(root, 'claimPath')
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

        await writePathClaims(
          root,
          upsertClaim(claims, { pageId: claim.pageId, path: relativePath }),
        )
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
        const rootRealPath = await canonicalRoot(root, 'materialize')
        const { relativePath, absolutePath } = await safeWorkspacePath({
          root,
          rootRealPath,
          path: plan.path,
          policy: policy.pathPolicy,
          operation: 'materialize',
        })
        const sidecars = await readFilesystemSidecars(root, 'materialize')
        const claims = await readPathClaims(root, 'materialize')
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

        await mkdir(dirname(absolutePath), { recursive: true })
        await writeFile(absolutePath, content, 'utf8')
        await writeJsonFile(
          filesystemWorkspacePageSidecarPath({ root, pageId: plan.pageId }),
          sidecar,
        )
        await writePathClaims(
          root,
          upsertClaim(claims, { pageId: plan.pageId, path: relativePath }),
        )

        return decode(MaterializeResult, {
          _tag: 'MaterializeResult',
          pageId: plan.pageId,
          path: relativePath,
          bodyHash: plan.bodyPointer.bodyHash,
          ownWriteSuppressionToken: token,
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

export const filesystemLocalWorkspacePortLayer = (input: FilesystemLocalWorkspaceInput) =>
  Layer.succeed(LocalWorkspacePort, makeFilesystemLocalWorkspacePort(input))

export type FakeLocalWorkspaceInput = {
  readonly observations?: ReadonlyArray<LocalArtifactObservationType>
  readonly claimedPaths?: ReadonlyArray<PathClaimPlan>
  readonly symlinkEscapes?: ReadonlyArray<string>
  readonly policy?: WorkspacePolicy
}

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
      decode(AbsolutePath, root)
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
      const result = decode(MaterializeResult, {
        _tag: 'MaterializeResult',
        pageId: plan.pageId,
        path: plan.path,
        bodyHash: plan.bodyPointer.bodyHash,
        ownWriteSuppressionToken: token,
      })
      return Effect.succeed(result)
    },
  }
}

export const fakeLocalWorkspacePortLayer = (input?: FakeLocalWorkspaceInput) =>
  Layer.succeed(LocalWorkspacePort, makeFakeLocalWorkspacePort(input))

export const presentArtifactObservation = (
  input: Omit<LocalArtifactObservationType, '_tag' | 'state'>,
): LocalArtifactObservationType => ({
  _tag: 'LocalArtifactObservation',
  ...input,
  state: 'present',
})
