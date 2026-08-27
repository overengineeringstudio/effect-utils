/* eslint-disable no-await-in-loop -- Durable publication, fsync, and teardown order is intentional. */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import * as NodePath from 'node:path'

import { Effect, Schema } from 'effect'

import type { AbsoluteDirPath, CompositionGeneratorConfig } from '../config.ts'
import {
  BUCK_MEMBER_MANIFEST_FILENAME,
  COMPOSITION_GENERATION_MANIFEST_PATH,
  COMPOSITION_ROOT_SCHEMA_VERSION,
  CompositionGenerationManifestSchema,
  decodeBuckMemberManifestJson,
  generateCompositionRoot,
  type BuckCacheSection,
  type BuckMemberManifest,
  type CompositionGenerationManifest,
  type GeneratedCompositionFile,
} from './composition-root.ts'

const strictParseOptions = { errors: 'all', onExcessProperty: 'error' } as const
const PREVIOUS_MANIFEST_PATH = '.megarepo/composition-generation.previous.json' as const
const CANDIDATE_SUFFIX = '.megarepo-composition-candidate' as const
const OWNED_DIRECTORIES = ['.megarepo/bin', '.megarepo', 'none', 'toolchains'] as const
const CONSTANT_PATHS = ['.buckroot', 'BUCK', 'none/BUCK', 'toolchains/BUCK'] as const
const memberKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/** Typed refusal or recoverable filesystem publication failure. */
export class CompositionRootPublicationError extends Schema.TaggedError<CompositionRootPublicationError>()(
  'CompositionRootPublicationError',
  {
    reason: Schema.Literals([
      'InvalidInput',
      'InvalidMemberManifest',
      'CapabilityPrerequisiteFailure',
      'InvalidGenerationManifest',
      'ForeignPath',
      'IoFailure',
    ]),
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** One member whose projected capabilities must already have passed their external check. */
export interface CompositionCapabilityProjectionInput {
  readonly workspaceRoot: AbsoluteDirPath
  readonly memberKey: string
  readonly memberRoot: string
  readonly manifest: BuckMemberManifest
  readonly owned: boolean
}

/** Publication callbacks are assertions/observers only; they may not mutate mounts. */
export interface CompositionRootPublicationRuntime {
  readonly assertCapabilityProjection: (
    input: CompositionCapabilityProjectionInput,
  ) => Promise<void>
  /** Crash-boundary seam after candidate bytes and mode are durable, before any final rename. */
  readonly afterCandidateFile?: (path: string) => Promise<void>
  /** Observation seam after the final rename and parent-directory fsync. */
  readonly afterPublishedFile?: (path: string) => Promise<void>
}

/** Complete explicit inputs for composition-root publication. */
export interface PublishCompositionRootOptions {
  readonly workspaceRoot: AbsoluteDirPath
  /** Exact member keys from the authoritative megarepo config. */
  readonly configMemberKeys: ReadonlyArray<string>
  readonly ownedMemberKey: string
  readonly compositionConfig: CompositionGeneratorConfig
  /** Absolute, Nix-resolved Buck2 executable. PATH lookup is intentionally impossible. */
  readonly resolvedBuckExecutable: string
  readonly cacheSections?: ReadonlyArray<BuckCacheSection>
  readonly runtime: CompositionRootPublicationRuntime
}

/** Observable result of an idempotent composition publication. */
export interface CompositionRootPublicationResult {
  readonly changedPaths: ReadonlyArray<string>
  readonly memberManifests: ReadonlyArray<{
    readonly memberKey: string
    readonly manifest: BuckMemberManifest
  }>
}

/** Explicit workspace root whose generated composition files should be removed. */
export interface TeardownCompositionRootOptions {
  readonly workspaceRoot: AbsoluteDirPath
}

/** Generated files and now-empty owned directories removed by teardown. */
export interface CompositionRootTeardownResult {
  readonly removedPaths: ReadonlyArray<string>
  readonly removedDirectories: ReadonlyArray<string>
}

type PublicationReason = CompositionRootPublicationError['reason']
type FileSnapshot = {
  readonly mode: number
  readonly bytes: Uint8Array
  readonly sha256: string
}

const failure = ({
  reason,
  path,
  message,
  cause,
}: {
  readonly reason: PublicationReason
  readonly path: string
  readonly message: string
  readonly cause?: unknown
}): CompositionRootPublicationError =>
  new CompositionRootPublicationError({ reason, path, message, cause })

const normalizeFailure = ({
  cause,
  path,
  message,
  reason = 'IoFailure',
}: {
  readonly cause: unknown
  readonly path: string
  readonly message: string
  readonly reason?: PublicationReason
}): CompositionRootPublicationError =>
  cause instanceof CompositionRootPublicationError
    ? cause
    : failure({ reason, path, message, cause })

const isErrno = (...[cause, code]: readonly [unknown, string]): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  (cause as { readonly code?: unknown }).code === code

const lstatMaybe = async (path: string) => {
  try {
    return await lstat(path)
  } catch (cause) {
    if (isErrno(cause, 'ENOENT') === true) return undefined
    throw cause
  }
}

const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const readRegularFile = async (path: string): Promise<FileSnapshot | undefined> => {
  const info = await lstatMaybe(path)
  if (info === undefined) return undefined
  if (info.isFile() === false) {
    throw failure({
      reason: 'ForeignPath',
      path,
      message: `Refusing non-regular composition-owned path: ${path}`,
    })
  }
  const bytes = await readFile(path)
  return { mode: info.mode & 0o777, bytes, sha256: sha256(bytes) }
}

const bytesEqual = (...[left, right]: readonly [Uint8Array, Uint8Array]): boolean =>
  left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right))

const snapshotMatchesFile = (
  ...[snapshot, file]: readonly [FileSnapshot, GeneratedCompositionFile]
): boolean => snapshot.mode === file.mode && bytesEqual(snapshot.bytes, file.bytes)

const syncDirectory = async (path: string): Promise<void> => {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY)
    await handle.sync()
  } finally {
    await handle?.close()
  }
}

const ensureDirectory = async (
  ...[workspaceRoot, relativePath]: readonly [string, string]
): Promise<void> => {
  let current = workspaceRoot
  for (const segment of relativePath.split('/')) {
    const parent = current
    current = NodePath.join(current, segment)
    const info = await lstatMaybe(current)
    if (info === undefined) {
      await mkdir(current)
      await syncDirectory(parent)
    } else if (info.isDirectory() === false) {
      throw failure({
        reason: 'ForeignPath',
        path: current,
        message: `Refusing non-directory composition-owned path component: ${current}`,
      })
    }
  }
}

const finalPathFor = (...[workspaceRoot, relativePath]: readonly [string, string]): string =>
  NodePath.join(workspaceRoot, ...relativePath.split('/'))

const candidatePathFor = (...[workspaceRoot, relativePath]: readonly [string, string]): string => {
  const finalPath = finalPathFor(workspaceRoot, relativePath)
  return NodePath.join(
    NodePath.dirname(finalPath),
    `.${NodePath.basename(finalPath)}${CANDIDATE_SUFFIX}`,
  )
}

const decodeGenerationManifest = ({
  bytes,
  path,
}: {
  readonly bytes: Uint8Array
  readonly path: string
}): CompositionGenerationManifest => {
  try {
    return Schema.decodeUnknownSync(
      Schema.fromJsonString(CompositionGenerationManifestSchema),
      strictParseOptions,
    )(Buffer.from(bytes).toString('utf8'))
  } catch (cause) {
    throw failure({
      reason: 'InvalidGenerationManifest',
      path,
      message: `Invalid composition generation manifest: ${path}`,
      cause,
    })
  }
}

const assertManifestShape = ({
  manifest,
  expectedPaths,
  path,
}: {
  readonly manifest: CompositionGenerationManifest
  readonly expectedPaths: ReadonlyArray<string>
  readonly path: string
}): void => {
  const actualPaths = manifest.files.map((file) => file.path)
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((value, index) => value !== expectedPaths[index]) === true
  ) {
    throw failure({
      reason: 'InvalidGenerationManifest',
      path,
      message: `Composition generation manifest does not own the canonical file set: ${path}`,
    })
  }
}

const readManifestMaybe = async ({
  workspaceRoot,
  relativePath,
  expectedPaths,
}: {
  readonly workspaceRoot: string
  readonly relativePath: string
  readonly expectedPaths: ReadonlyArray<string>
}): Promise<
  { readonly snapshot: FileSnapshot; readonly manifest: CompositionGenerationManifest } | undefined
> => {
  const path = finalPathFor(workspaceRoot, relativePath)
  const snapshot = await readRegularFile(path)
  if (snapshot === undefined) return undefined
  const manifest = decodeGenerationManifest({ bytes: snapshot.bytes, path })
  assertManifestShape({ manifest, expectedPaths, path })
  return { snapshot, manifest }
}

const recordMatches = ({
  snapshot,
  manifest,
  relativePath,
}: {
  readonly snapshot: FileSnapshot
  readonly manifest: CompositionGenerationManifest
  readonly relativePath: string
}): boolean => {
  const record = manifest.files.find((file) => file.path === relativePath)
  return record !== undefined && record.mode === snapshot.mode && record.sha256 === snapshot.sha256
}

const validatePublicationState = async ({
  workspaceRoot,
  files,
}: {
  readonly workspaceRoot: string
  readonly files: ReadonlyArray<GeneratedCompositionFile>
}): Promise<{
  readonly currentManifest: CompositionGenerationManifest | undefined
  readonly previousManifest: CompositionGenerationManifest | undefined
}> => {
  const generatedWithoutManifest = files
    .filter((file) => file.path !== COMPOSITION_GENERATION_MANIFEST_PATH)
    .map((file) => file.path)
    .toSorted()
  const current = await readManifestMaybe({
    workspaceRoot,
    relativePath: COMPOSITION_GENERATION_MANIFEST_PATH,
    expectedPaths: generatedWithoutManifest,
  })
  const previous = await readManifestMaybe({
    workspaceRoot,
    relativePath: PREVIOUS_MANIFEST_PATH,
    expectedPaths: generatedWithoutManifest,
  })
  if (previous !== undefined && current === undefined) {
    throw failure({
      reason: 'InvalidGenerationManifest',
      path: finalPathFor(workspaceRoot, PREVIOUS_MANIFEST_PATH),
      message: 'Previous generation manifest exists without the current generation manifest',
    })
  }

  const configPath = finalPathFor(workspaceRoot, '.buckconfig')
  if (current === undefined && (await lstatMaybe(configPath)) !== undefined) {
    throw failure({
      reason: 'InvalidGenerationManifest',
      path: configPath,
      message: 'Refusing an existing .buckconfig without a valid generation manifest',
    })
  }

  for (const file of files) {
    if (file.path === COMPOSITION_GENERATION_MANIFEST_PATH) continue
    const path = finalPathFor(workspaceRoot, file.path)
    const snapshot = await readRegularFile(path)
    if (snapshot === undefined) {
      if (current !== undefined && file.path !== '.buckconfig') {
        throw failure({
          reason: 'ForeignPath',
          path,
          message: `Composition-owned file recorded by the manifest is missing: ${path}`,
        })
      }
      continue
    }
    const matchesCurrent =
      current !== undefined &&
      recordMatches({ snapshot, manifest: current.manifest, relativePath: file.path })
    const matchesPrevious =
      previous !== undefined &&
      recordMatches({ snapshot, manifest: previous.manifest, relativePath: file.path })
    if (
      matchesCurrent === false &&
      matchesPrevious === false &&
      snapshotMatchesFile(snapshot, file) === false
    ) {
      throw failure({
        reason: 'ForeignPath',
        path,
        message: `Refusing to replace composition path whose bytes or mode are not owned: ${path}`,
      })
    }
  }

  return {
    currentManifest: current?.manifest,
    previousManifest: previous?.manifest,
  }
}

const stageFile = async ({
  workspaceRoot,
  file,
  runtime,
}: {
  readonly workspaceRoot: string
  readonly file: GeneratedCompositionFile
  readonly runtime: CompositionRootPublicationRuntime
}): Promise<string> => {
  const candidatePath = candidatePathFor(workspaceRoot, file.path)
  const existing = await readRegularFile(candidatePath)
  if (existing !== undefined) {
    if (snapshotMatchesFile(existing, file) === false) {
      throw failure({
        reason: 'ForeignPath',
        path: candidatePath,
        message: `Refusing foreign composition candidate: ${candidatePath}`,
      })
    }
  } else {
    let handle: FileHandle | undefined
    try {
      handle = await open(
        candidatePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        file.mode,
      )
      await handle.chmod(file.mode)
      await handle.writeFile(file.bytes)
      await handle.sync()
    } finally {
      await handle?.close()
    }
    await syncDirectory(NodePath.dirname(candidatePath))
  }
  await runtime.afterCandidateFile?.(file.path)
  return candidatePath
}

const removeFileDurably = async (path: string): Promise<void> => {
  await unlink(path)
  await syncDirectory(NodePath.dirname(path))
}

const publishCandidate = async ({
  workspaceRoot,
  file,
  candidatePath,
  runtime,
}: {
  readonly workspaceRoot: string
  readonly file: GeneratedCompositionFile
  readonly candidatePath: string
  readonly runtime: CompositionRootPublicationRuntime
}): Promise<void> => {
  const finalPath = finalPathFor(workspaceRoot, file.path)
  await rename(candidatePath, finalPath)
  await syncDirectory(NodePath.dirname(finalPath))
  await runtime.afterPublishedFile?.(file.path)
}

const writePreviousManifest = async ({
  workspaceRoot,
  bytes,
}: {
  readonly workspaceRoot: string
  readonly bytes: Uint8Array
}): Promise<void> => {
  const relativePath = PREVIOUS_MANIFEST_PATH
  const path = finalPathFor(workspaceRoot, relativePath)
  const existing = await readRegularFile(path)
  if (existing !== undefined) {
    if (existing.mode !== 0o644 || bytesEqual(existing.bytes, bytes) === false) {
      throw failure({
        reason: 'ForeignPath',
        path,
        message: `Refusing foreign previous-manifest journal: ${path}`,
      })
    }
    return
  }
  const candidatePath = `${path}${CANDIDATE_SUFFIX}`
  const candidate = await readRegularFile(candidatePath)
  if (candidate !== undefined) {
    if (candidate.mode !== 0o644 || bytesEqual(candidate.bytes, bytes) === false) {
      throw failure({
        reason: 'ForeignPath',
        path: candidatePath,
        message: `Refusing foreign previous-manifest candidate: ${candidatePath}`,
      })
    }
  } else {
    let handle: FileHandle | undefined
    try {
      handle = await open(
        candidatePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o644,
      )
      await handle.chmod(0o644)
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle?.close()
    }
    await syncDirectory(NodePath.dirname(candidatePath))
  }
  await rename(candidatePath, path)
  await syncDirectory(NodePath.dirname(path))
}

const cleanupCandidate = async ({
  workspaceRoot,
  file,
}: {
  readonly workspaceRoot: string
  readonly file: GeneratedCompositionFile
}): Promise<void> => {
  const candidatePath = candidatePathFor(workspaceRoot, file.path)
  const candidate = await readRegularFile(candidatePath)
  if (candidate === undefined) return
  if (snapshotMatchesFile(candidate, file) === false) {
    throw failure({
      reason: 'ForeignPath',
      path: candidatePath,
      message: `Refusing foreign composition candidate: ${candidatePath}`,
    })
  }
  await removeFileDurably(candidatePath)
}

const assertCompleteBeforeAuthority = async ({
  workspaceRoot,
  files,
}: {
  readonly workspaceRoot: string
  readonly files: ReadonlyArray<GeneratedCompositionFile>
}): Promise<void> => {
  for (const file of files) {
    if (file.path === '.buckconfig') continue
    const path = finalPathFor(workspaceRoot, file.path)
    const snapshot = await readRegularFile(path)
    if (snapshot === undefined || snapshotMatchesFile(snapshot, file) === false) {
      throw failure({
        reason: 'ForeignPath',
        path,
        message: `Composition publication is incomplete before .buckconfig authority: ${path}`,
      })
    }
  }
  for (const relativePath of CONSTANT_PATHS) {
    const file = files.find((candidate) => candidate.path === relativePath)
    const snapshot = await readRegularFile(finalPathFor(workspaceRoot, relativePath))
    if (
      file === undefined ||
      snapshot === undefined ||
      snapshotMatchesFile(snapshot, file) === false
    ) {
      throw failure({
        reason: 'ForeignPath',
        path: finalPathFor(workspaceRoot, relativePath),
        message: `Composition constant is not exact before .buckconfig authority: ${relativePath}`,
      })
    }
  }
}

const validateWorkspaceRoot = async (workspaceRoot: string): Promise<void> => {
  if (NodePath.isAbsolute(workspaceRoot) === false) {
    throw failure({
      reason: 'InvalidInput',
      path: workspaceRoot,
      message: 'Composition workspace root must be absolute',
    })
  }
  const info = await lstatMaybe(workspaceRoot)
  if (info === undefined || info.isDirectory() === false) {
    throw failure({
      reason: 'InvalidInput',
      path: workspaceRoot,
      message: 'Composition workspace root must be an existing directory',
    })
  }
}

const loadMembers = async ({
  workspaceRoot,
  configMemberKeys,
  ownedMemberKey,
}: {
  readonly workspaceRoot: AbsoluteDirPath
  readonly configMemberKeys: ReadonlyArray<string>
  readonly ownedMemberKey: string
}) => {
  const memberKeys = [...configMemberKeys]
  const uniqueKeys = new Set(memberKeys)
  if (
    memberKeys.length === 0 ||
    uniqueKeys.size !== memberKeys.length ||
    memberKeys.some((key) => memberKeyPattern.test(key) === false) === true
  ) {
    throw failure({
      reason: 'InvalidInput',
      path: workspaceRoot,
      message: 'Composition config member keys must be non-empty, unique canonical segments',
    })
  }
  if (uniqueKeys.has(ownedMemberKey) === false) {
    throw failure({
      reason: 'InvalidInput',
      path: workspaceRoot,
      message: `Owned member is not present in the composition config: ${ownedMemberKey}`,
    })
  }

  const members = [] as Array<{
    readonly memberKey: string
    readonly memberRoot: string
    readonly manifest: BuckMemberManifest
  }>
  for (const memberKey of memberKeys) {
    const memberRoot = NodePath.join(workspaceRoot, 'repos', memberKey)
    const memberInfo = await lstatMaybe(memberRoot)
    if (memberInfo === undefined || memberInfo.isDirectory() === false) {
      throw failure({
        reason: 'InvalidMemberManifest',
        path: memberRoot,
        message: `Composition member root is missing or not a directory: ${memberRoot}`,
      })
    }
    const manifestPath = NodePath.join(memberRoot, BUCK_MEMBER_MANIFEST_FILENAME)
    try {
      const manifest = decodeBuckMemberManifestJson(await readFile(manifestPath, 'utf8'))
      members.push({ memberKey, memberRoot, manifest })
    } catch (cause) {
      throw normalizeFailure({
        cause,
        path: manifestPath,
        reason: 'InvalidMemberManifest',
        message: `Could not strictly decode member manifest: ${manifestPath}`,
      })
    }
  }
  return members
}

/**
 * Publish a generated Buck2 composition root. This primitive performs filesystem publication only:
 * it invokes no Git, Nix, mount, or command operation.
 */
export const publishCompositionRoot = Effect.fn('megarepo/composition-root/publish')(
  (options: PublishCompositionRootOptions) =>
    Effect.tryPromise({
      try: async (): Promise<CompositionRootPublicationResult> => {
        const workspaceRoot = NodePath.resolve(options.workspaceRoot)
        await validateWorkspaceRoot(workspaceRoot)
        const members = await loadMembers({
          workspaceRoot: workspaceRoot as AbsoluteDirPath,
          configMemberKeys: options.configMemberKeys,
          ownedMemberKey: options.ownedMemberKey,
        })
        const hub = members.find(
          (member) => member.memberKey === options.compositionConfig.platformHub,
        )
        if (hub === undefined) {
          throw failure({
            reason: 'InvalidInput',
            path: workspaceRoot,
            message: `Composition platform hub is not a configured member: ${options.compositionConfig.platformHub}`,
          })
        }

        let output: ReturnType<typeof generateCompositionRoot>
        try {
          output = generateCompositionRoot({
            schemaVersion: COMPOSITION_ROOT_SCHEMA_VERSION,
            members: members.map(({ memberKey, manifest }) => ({ memberKey, manifest })),
            platformHubCell: hub.manifest.cell,
            isolationDir: options.compositionConfig.isolationDir,
            cacheSections: options.cacheSections,
            resolvedBuckExecutable: options.resolvedBuckExecutable,
          })
        } catch (cause) {
          throw failure({
            reason: 'InvalidInput',
            path: workspaceRoot,
            message: 'Composition member and generator inputs are inconsistent',
            cause,
          })
        }

        for (const member of members) {
          try {
            await options.runtime.assertCapabilityProjection({
              workspaceRoot: workspaceRoot as AbsoluteDirPath,
              memberKey: member.memberKey,
              memberRoot: member.memberRoot,
              manifest: member.manifest,
              owned: member.memberKey === options.ownedMemberKey,
            })
          } catch (cause) {
            throw failure({
              reason: 'CapabilityPrerequisiteFailure',
              path: member.memberRoot,
              message: `Capability projection prerequisite failed for member ${member.memberKey}`,
              cause,
            })
          }
        }

        for (const directory of ['.megarepo', '.megarepo/bin', 'none', 'toolchains']) {
          await ensureDirectory(workspaceRoot, directory)
        }
        const state = await validatePublicationState({ workspaceRoot, files: output.files })
        const desiredByPath = new Map(output.files.map((file) => [file.path, file]))
        const changed = [] as Array<GeneratedCompositionFile>
        for (const file of output.files) {
          const snapshot = await readRegularFile(finalPathFor(workspaceRoot, file.path))
          if (snapshot === undefined || snapshotMatchesFile(snapshot, file) === false)
            changed.push(file)
          else await cleanupCandidate({ workspaceRoot, file })
        }

        const previousPath = finalPathFor(workspaceRoot, PREVIOUS_MANIFEST_PATH)
        if (changed.length === 0) {
          const previous = await readRegularFile(previousPath)
          if (previous !== undefined) await removeFileDurably(previousPath)
          return {
            changedPaths: [],
            memberManifests: members.map(({ memberKey, manifest }) => ({ memberKey, manifest })),
          }
        }

        if (state.currentManifest !== undefined && (await lstatMaybe(previousPath)) === undefined) {
          const currentManifest = await readRegularFile(
            finalPathFor(workspaceRoot, COMPOSITION_GENERATION_MANIFEST_PATH),
          )
          if (currentManifest === undefined) {
            throw failure({
              reason: 'InvalidGenerationManifest',
              path: finalPathFor(workspaceRoot, COMPOSITION_GENERATION_MANIFEST_PATH),
              message: 'Generation manifest disappeared during publication validation',
            })
          }
          await writePreviousManifest({ workspaceRoot, bytes: currentManifest.bytes })
        }

        const staged = new Map<string, string>()
        for (const file of changed) {
          staged.set(file.path, await stageFile({ workspaceRoot, file, runtime: options.runtime }))
        }
        // Candidate callbacks are an intentional race/fault seam. Recheck all owned finals after
        // staging and before the first overwrite so a replacement at that boundary is refused.
        await validatePublicationState({ workspaceRoot, files: output.files })

        const commitOrder = [
          ...changed.filter(
            (file) =>
              file.path !== COMPOSITION_GENERATION_MANIFEST_PATH && file.path !== '.buckconfig',
          ),
          ...changed.filter((file) => file.path === COMPOSITION_GENERATION_MANIFEST_PATH),
          ...changed.filter((file) => file.path === '.buckconfig'),
        ]
        for (const file of commitOrder) {
          if (file.path === '.buckconfig') {
            await assertCompleteBeforeAuthority({ workspaceRoot, files: output.files })
          }
          const candidatePath = staged.get(file.path)
          if (candidatePath === undefined) {
            throw failure({
              reason: 'IoFailure',
              path: finalPathFor(workspaceRoot, file.path),
              message: `Missing staged composition candidate: ${file.path}`,
            })
          }
          await publishCandidate({
            workspaceRoot,
            file,
            candidatePath,
            runtime: options.runtime,
          })
        }

        for (const file of output.files) {
          const expected = desiredByPath.get(file.path)
          if (expected !== undefined) await cleanupCandidate({ workspaceRoot, file: expected })
        }
        if ((await lstatMaybe(previousPath)) !== undefined) await removeFileDurably(previousPath)

        return {
          changedPaths: commitOrder.map((file) => file.path),
          memberManifests: members.map(({ memberKey, manifest }) => ({ memberKey, manifest })),
        }
      },
      catch: (cause) =>
        normalizeFailure({
          cause,
          path: options.workspaceRoot,
          message: 'Could not publish Buck2 composition root',
        }),
    }),
)

const validateTeardownState = async ({
  workspaceRoot,
}: {
  readonly workspaceRoot: string
}): Promise<CompositionGenerationManifest> => {
  const manifestPath = finalPathFor(workspaceRoot, COMPOSITION_GENERATION_MANIFEST_PATH)
  const manifestSnapshot = await readRegularFile(manifestPath)
  if (manifestSnapshot === undefined) {
    throw failure({
      reason: 'InvalidGenerationManifest',
      path: manifestPath,
      message: 'Cannot teardown composition root without its generation manifest',
    })
  }
  const manifest = decodeGenerationManifest({ bytes: manifestSnapshot.bytes, path: manifestPath })
  const canonicalPaths = [
    '.buckconfig',
    '.buckroot',
    '.megarepo/bin/buck2',
    'BUCK',
    'none/BUCK',
    'toolchains/BUCK',
  ].toSorted()
  assertManifestShape({ manifest, expectedPaths: canonicalPaths, path: manifestPath })
  if ((await lstatMaybe(finalPathFor(workspaceRoot, PREVIOUS_MANIFEST_PATH))) !== undefined) {
    throw failure({
      reason: 'InvalidGenerationManifest',
      path: finalPathFor(workspaceRoot, PREVIOUS_MANIFEST_PATH),
      message:
        'Cannot teardown an interrupted composition publication; publish again to recover first',
    })
  }
  for (const record of manifest.files) {
    const path = finalPathFor(workspaceRoot, record.path)
    const snapshot = await readRegularFile(path)
    if (
      snapshot === undefined ||
      snapshot.mode !== record.mode ||
      snapshot.sha256 !== record.sha256
    ) {
      throw failure({
        reason: 'ForeignPath',
        path,
        message: `Refusing teardown because generated file ownership changed: ${path}`,
      })
    }
  }
  return manifest
}

/** Remove only strictly verified generated files and now-empty generator-owned directories. */
export const teardownCompositionRoot = Effect.fn('megarepo/composition-root/teardown')(
  (options: TeardownCompositionRootOptions) =>
    Effect.tryPromise({
      try: async (): Promise<CompositionRootTeardownResult> => {
        const workspaceRoot = NodePath.resolve(options.workspaceRoot)
        await validateWorkspaceRoot(workspaceRoot)
        const manifest = await validateTeardownState({ workspaceRoot })
        const removalOrder = [
          ...manifest.files.filter((file) => file.path === '.buckconfig'),
          ...manifest.files.filter((file) => file.path !== '.buckconfig'),
        ]
        const removedPaths: string[] = []
        for (const record of removalOrder) {
          await removeFileDurably(finalPathFor(workspaceRoot, record.path))
          removedPaths.push(record.path)
        }
        await removeFileDurably(finalPathFor(workspaceRoot, COMPOSITION_GENERATION_MANIFEST_PATH))
        removedPaths.push(COMPOSITION_GENERATION_MANIFEST_PATH)

        const removedDirectories: string[] = []
        for (const relativePath of OWNED_DIRECTORIES) {
          const path = finalPathFor(workspaceRoot, relativePath)
          try {
            await rmdir(path)
            await syncDirectory(NodePath.dirname(path))
            removedDirectories.push(relativePath)
          } catch (cause) {
            if (
              isErrno(cause, 'ENOENT') === false &&
              isErrno(cause, 'ENOTEMPTY') === false &&
              isErrno(cause, 'EEXIST') === false
            ) {
              throw cause
            }
          }
        }
        return { removedPaths, removedDirectories }
      },
      catch: (cause) =>
        normalizeFailure({
          cause,
          path: options.workspaceRoot,
          message: 'Could not teardown Buck2 composition root',
        }),
    }),
)
