import { execFile as execFileCallback } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import * as NodePath from 'node:path'
import { promisify } from 'node:util'

import { Schema } from 'effect'

import type {
  CompositionOwnedCapabilityProjectionPlan,
  CompositionOwnedCapabilityProjectionResult,
} from './composition-apply-schema.ts'

const execFile = promisify(execFileCallback)
const generationPattern = /^[0-9a-f]{64}$/u

export class OwnedCapabilityProjectionError extends Schema.TaggedError<OwnedCapabilityProjectionError>()(
  'OwnedCapabilityProjectionError',
  {
    reason: Schema.Literals(['InvalidInput', 'CopyFailed', 'VerificationFailed', 'PublishFailed']),
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Exact tools and nonce source needed for an atomic owned-worktree projection install. */
export interface OwnedCapabilityProjectionRuntime {
  readonly cpPath: string
  readonly mvPath: string
  readonly nonce?: () => string
}

const failure = ({
  reason,
  path,
  message,
  cause,
}: {
  readonly reason: OwnedCapabilityProjectionError['reason']
  readonly path: string
  readonly message: string
  readonly cause?: unknown
}) =>
  new OwnedCapabilityProjectionError({
    reason,
    path,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const normalizedAbsolute = ({ value, name }: { readonly value: string; readonly name: string }) => {
  if (NodePath.isAbsolute(value) === false || NodePath.normalize(value) !== value) {
    throw failure({
      reason: 'InvalidInput',
      path: value,
      message: `${name} must be a normalized absolute path`,
    })
  }
  return value
}

const containedBy = ({ root, path }: { readonly root: string; readonly path: string }) =>
  path === root || path.startsWith(`${root}${NodePath.sep}`) === true

const assertDirectory = async ({ path, parent }: { readonly path: string; readonly parent?: string }) => {
  const info = await lstat(path)
  const physical = await realpath(path)
  if (
    info.isDirectory() === false ||
    info.isSymbolicLink() === true ||
    (parent !== undefined && containedBy({ root: parent, path: physical }) === false)
  ) {
    throw new TypeError(`Expected a real contained directory at '${path}'`)
  }
  return physical
}

const readGeneration = async ({ projectionPath }: { readonly projectionPath: string }) => {
  const physicalProjection = await assertDirectory({ path: projectionPath })
  const defsPath = NodePath.join(projectionPath, 'defs.bzl')
  let handle
  try {
    const beforePath = await lstat(defsPath)
    const physicalDefs = await realpath(defsPath)
    if (
      beforePath.isFile() === false ||
      beforePath.isSymbolicLink() === true ||
      containedBy({ root: physicalProjection, path: physicalDefs }) === false
    ) {
      throw new TypeError('defs.bzl must be a contained regular file')
    }
    handle = await open(defsPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat()
    const bytes = await handle.readFile({ encoding: 'utf8' })
    const after = await handle.stat()
    if (before.dev !== beforePath.dev || before.ino !== beforePath.ino || after.ino !== before.ino) {
      throw new TypeError('defs.bzl identity changed while reading')
    }
    const matches = [...bytes.matchAll(/^GENERATION = "([0-9a-f]{64})"$/gmu)]
    if (matches.length !== 1 || generationPattern.test(matches[0]![1]!) === false) {
      throw new TypeError('defs.bzl must declare exactly one valid GENERATION')
    }
    return matches[0]![1]!
  } finally {
    await handle?.close()
  }
}

const runExact = async ({ executable, args }: { readonly executable: string; readonly args: ReadonlyArray<string> }) => {
  await execFile(executable, [...args], { maxBuffer: 1024 * 1024 })
}

/** Mutation-free description of the owned capability projection boundary. */
export const planOwnedCapabilityProjection = async ({
  memberKey,
  ownedMemberPath,
  projectionPath,
}: {
  readonly memberKey: string
  readonly ownedMemberPath: string
  readonly projectionPath: string
}): Promise<CompositionOwnedCapabilityProjectionPlan> => {
  normalizedAbsolute({ value: ownedMemberPath, name: 'ownedMemberPath' })
  normalizedAbsolute({ value: projectionPath, name: 'projectionPath' })
  return {
    memberKey,
    ownedMemberPath,
    projectionPath,
    operation: 'InstallOwnedCapabilityProjection',
    steps: ['ValidateOwnedMember', 'InstallProjectionAtomically', 'CheckProjection'],
  }
}

/**
 * Copy a checked scratch projection into the writable member and publish it with one atomic
 * directory exchange. Existing equal projections are left untouched.
 */
export const installOwnedCapabilityProjection = async ({
  memberKey,
  ownedMemberPath: rawOwnedMemberPath,
  projectionPath: rawProjectionPath,
  projectionDigest,
  runtime,
}: {
  readonly memberKey: string
  readonly ownedMemberPath: string
  readonly projectionPath: string
  readonly projectionDigest: string
  readonly runtime: OwnedCapabilityProjectionRuntime
}): Promise<CompositionOwnedCapabilityProjectionResult> => {
  const ownedMemberPath = normalizedAbsolute({ value: rawOwnedMemberPath, name: 'ownedMemberPath' })
  const projectionPath = normalizedAbsolute({ value: rawProjectionPath, name: 'projectionPath' })
  normalizedAbsolute({ value: runtime.cpPath, name: 'cpPath' })
  normalizedAbsolute({ value: runtime.mvPath, name: 'mvPath' })
  if (generationPattern.test(projectionDigest) === false) {
    throw failure({
      reason: 'InvalidInput',
      path: projectionPath,
      message: 'projectionDigest must be a lowercase sha256 identity',
    })
  }

  try {
    const physicalOwned = await assertDirectory({ path: ownedMemberPath })
    await access(NodePath.join(ownedMemberPath, '.git'), constants.R_OK)
    const physicalProjection = await assertDirectory({ path: projectionPath })
    if (containedBy({ root: physicalOwned, path: physicalProjection }) === true) {
      throw new TypeError('scratch projection must not be inside the owned member')
    }
    if ((await readGeneration({ projectionPath })) !== projectionDigest) {
      throw new TypeError('scratch projection generation does not match its checked digest')
    }
  } catch (cause) {
    throw failure({
      reason: 'VerificationFailed',
      path: projectionPath,
      message: 'Owned capability projection input failed verification',
      cause,
    })
  }

  const capabilityParent = NodePath.join(ownedMemberPath, '.buck2')
  const destination = NodePath.join(capabilityParent, 'capabilities')
  await mkdir(capabilityParent, { recursive: true })
  const token = runtime.nonce?.() ?? randomBytes(16).toString('hex')
  if (/^[A-Za-z0-9._-]+$/u.test(token) === false) {
    throw failure({
      reason: 'InvalidInput',
      path: capabilityParent,
      message: 'Owned capability projection nonce is not path-safe',
    })
  }
  const stage = NodePath.join(capabilityParent, `.capabilities.stage-${token}`)
  await rm(stage, { recursive: true, force: true })

  try {
    await runExact({ executable: runtime.cpPath, args: ['-a', '--', projectionPath, stage] })
    if ((await readGeneration({ projectionPath: stage })) !== projectionDigest) {
      throw new TypeError('copied projection generation changed')
    }
  } catch (cause) {
    await rm(stage, { recursive: true, force: true })
    throw failure({
      reason: 'CopyFailed',
      path: stage,
      message: 'Could not create a verified private capability candidate',
      cause,
    })
  }

  let destinationExists = true
  let currentGeneration: string | undefined
  try {
    currentGeneration = await readGeneration({ projectionPath: destination })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') destinationExists = false
    else {
      await rm(stage, { recursive: true, force: true })
      throw failure({
        reason: 'VerificationFailed',
        path: destination,
        message: 'Existing owned capability projection is not verifiable',
        cause,
      })
    }
  }

  if (currentGeneration === projectionDigest) {
    await rm(stage, { recursive: true, force: true })
    return { memberKey, projectionPath: destination, projectionDigest, changed: false }
  }

  try {
    if (destinationExists === false) {
      await runExact({ executable: runtime.mvPath, args: ['-T', '--no-clobber', '--', stage, destination] })
    } else {
      await runExact({ executable: runtime.mvPath, args: ['-T', '--exchange', '--', stage, destination] })
    }
    if ((await readGeneration({ projectionPath: destination })) !== projectionDigest) {
      throw new TypeError('published projection generation does not match')
    }
  } catch (cause) {
    if (destinationExists === true) {
      try {
        await runExact({ executable: runtime.mvPath, args: ['-T', '--exchange', '--', stage, destination] })
      } catch {
        // Preserve both trees for explicit recovery when rollback cannot be proven.
      }
    }
    throw failure({
      reason: 'PublishFailed',
      path: destination,
      message: 'Could not atomically publish the owned capability projection',
      cause,
    })
  }

  await rm(stage, { recursive: true, force: true })
  return { memberKey, projectionPath: destination, projectionDigest, changed: true }
}
