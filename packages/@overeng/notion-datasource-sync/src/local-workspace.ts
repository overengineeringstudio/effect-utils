import { Effect, Layer, Schema, Stream } from 'effect'

import {
  AbsolutePath,
  MaterializeResult,
  OwnWriteSuppressionToken,
  WorkspaceRelativePath,
  type Hash,
  type LocalArtifactObservation as LocalArtifactObservationType,
  type MaterializePlan,
  type OwnWriteSuppressionToken as OwnWriteSuppressionTokenType,
  type PageId,
  type PathClaimResult,
  type PathClaimPlan,
  type WorkspaceRelativePath as WorkspaceRelativePathType,
} from './domain.ts'
import { LocalStoreError } from './errors.ts'
import type { GuardName } from './guards.ts'
import { LocalWorkspacePort, type LocalWorkspacePortShape } from './ports.ts'

const decode = <TSchema extends Schema.Schema.AnyNoContext>(schema: TSchema, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

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
  readonly pageId: PageId
  readonly policy?: PathPolicy
}): WorkspacePathDecision =>
  canonicalizeWorkspaceRelativePath({
    path: `${titleSlug(title)}--${pageId}${policy.bodyExtension}`,
    policy,
  })

export type LocalDeleteClassification = {
  readonly _tag: 'local-delete-candidate'
  readonly pageId: PageId
  readonly path: WorkspaceRelativePathType
  readonly remoteTrash: 'blocked-by-default'
}

export const classifyLocalDelete = ({
  pageId,
  path,
}: {
  readonly pageId: PageId
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
  readonly pageId: PageId
  readonly path: WorkspaceRelativePathType
  readonly bodyHash: Hash
}): OwnWriteSuppressionTokenType =>
  decode(OwnWriteSuppressionToken, `materialize:${pageId}:${bodyHash}:${path}`)

export const isOwnWriteObservation = ({
  observation,
  token,
}: {
  readonly observation: LocalArtifactObservationType
  readonly token: OwnWriteSuppressionTokenType
}): boolean => observation.ownWriteSuppressionToken === token

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
  const claims = new Map<WorkspaceRelativePathType, PageId>(
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
