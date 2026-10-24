import { createHash } from 'node:crypto'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  capabilityDirectoryBuckBytes,
  capabilityManifestDigest,
  capabilityToolBuckBytes,
  computeCapabilityProjectionGeneration,
  renderCapabilityProjectionDefs,
  type CapabilityProjectionManifest,
} from '../packages/@overeng/megarepo/src/buck2-capabilities/capability-projection.ts'

/** Independent disposable profile mutations compared by the native proof. */
export const phases = ['baseline', 'selected', 'unused', 'action-env'] as const
/** One named phase in the native identity proof. */
export type Phase = (typeof phases)[number]
const categories = ['selected', 'unselected', 'dependency_negative', 'dependency_positive'] as const
/** Actual native RE action identity and cache outcome fields. */
export type IdentityAction = {
  category: string
  digest: string
  executionKind: number
  cacheUploadResult: number
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false
const field = ({ value, path }: { value: unknown; path: readonly string[] }): unknown =>
  path.reduce<unknown>(
    (current, key) => (record(current) === true ? current[key] : undefined),
    value,
  )

/** Read the pinned native ActionExecution wire surface, never a synthetic key. */
export const identityActions = (events: string): IdentityAction[] => {
  const actions: IdentityAction[] = []
  for (const line of events.split('\n').filter(Boolean)) {
    const value: unknown = JSON.parse(line)
    const action = field({ value, path: ['Event', 'data', 'SpanEnd', 'data', 'ActionExecution'] })
    const category = field({ value: action, path: ['name', 'category'] })
    if (typeof category !== 'string' || category.startsWith('capability_identity_') === false)
      continue
    if (field({ value: action, path: ['failed'] }) === true)
      throw new Error(`failed native identity action: ${category}`)
    const commands = field({ value: action, path: ['commands'] })
    let digest: string | undefined
    if (Array.isArray(commands) === true) {
      for (const attempt of commands) {
        const command = field({ value: attempt, path: ['details', 'command_kind', 'command'] })
        for (const variant of [
          'OmittedLocalCommand',
          'LocalCommand',
          'RemoteCommand',
          'WorkerCommand',
        ]) {
          const candidate = field({ value: command, path: [variant, 'action_digest'] })
          if (typeof candidate === 'string' && candidate.length > 0) digest = candidate
        }
      }
    }
    const executionKind = field({ value: action, path: ['execution_kind'] })
    const cacheUploadResult = field({ value: action, path: ['cache_upload_result'] })
    if (
      digest === undefined ||
      digest === '' ||
      typeof executionKind !== 'number' ||
      typeof cacheUploadResult !== 'number'
    ) {
      throw new Error(`missing actual RE action digest/cache outcome: ${category}`)
    }
    actions.push({ category, digest, executionKind, cacheUploadResult })
  }
  return actions
}

/** Every phase is cold locally; a stable key must be a remote hit in writer mode. */
export const assertIdentity = ({
  observations,
  requireRemoteHits = false,
}: {
  observations: Record<Phase, IdentityAction[]>
  requireRemoteHits?: boolean
}): void => {
  for (const phase of phases) {
    const actions = observations[phase]
    if (actions.length !== categories.length)
      throw new Error(`${phase}: expected exactly four native actions`)
    for (const name of categories) {
      const category = `capability_identity_${name}`
      const matching = actions.filter((action) => action.category === category)
      const baseline = observations.baseline.find((action) => action.category === category)
      const action = matching[0]
      if (matching.length !== 1 || action === undefined || baseline === undefined)
        throw new Error(`${phase}: missing/duplicate ${category}`)
      const changed = phase === 'action-env' || (phase === 'selected' && name !== 'unselected')
      if ((action.digest !== baseline.digest) !== changed) {
        throw new Error(
          `${phase}/${name}: expected RE action digest to ${changed === true ? 'change' : 'remain stable'}`,
        )
      }
      if (
        requireRemoteHits === true &&
        phase !== 'baseline' &&
        changed === false &&
        action.executionKind !== 3
      ) {
        throw new Error(`${phase}/${name}: stable action did not hit the remote action cache`)
      }
    }
  }
}

/** Cache-disabled cold execution is required for the executable boundary check. */
export const assertDependencyExecution = (actions: IdentityAction[]): void => {
  if (actions.length !== 2) throw new Error('dependency proof requires exactly two native actions')
  for (const name of ['dependency_negative', 'dependency_positive']) {
    const matching = actions.filter((action) => action.category === `capability_identity_${name}`)
    if (matching.length !== 1 || matching[0]?.executionKind !== 1) {
      throw new Error(`${name}: dependency proof must execute locally, not reuse a verdict`)
    }
  }
}
const prepareProfiles = async ({
  source,
  destination,
}: {
  source: string
  destination: string
}): Promise<void> => {
  const defs = await readFile(join(source, 'defs.bzl'), 'utf8')
  const platform = defs.match(/\n  "([^"]+)": \{/)?.[1]
  if (platform !== 'x86_64-linux' && platform !== 'aarch64-linux' && platform !== 'aarch64-macos') {
    throw new Error('projected profile has no admitted platform')
  }
  const matches = [
    ...defs.matchAll(/"([^"]+)": \{"generation": "[a-f0-9]+", "manifestDigest": "([a-f0-9]+)"/g),
  ]
  const manifests = await Promise.all(
    matches.map(async (match): Promise<CapabilityProjectionManifest> => {
      const [, toolId, digest] = match
      if (toolId === undefined || toolId === '' || digest === undefined || digest === '')
        throw new Error('invalid capability metadata')
      const bytes = await readFile(
        join(source, 'tools', platform, toolId, digest, 'manifest.json'),
        'utf8',
      )
      if (createHash('sha256').update(bytes).digest('hex') !== digest)
        throw new Error(`${toolId}: manifest digest mismatch`)
      const manifest: CapabilityProjectionManifest = JSON.parse(bytes)
      if (manifest.toolId !== toolId || manifest.executionPlatform !== platform)
        throw new Error('manifest metadata mismatch')
      return manifest
    }),
  )
  for (const tool of ['bun', 'node', 'action-env', 'coreutils-readlink']) {
    if (manifests.some((manifest) => manifest.toolId === tool) === false)
      throw new Error(`proof requires projected ${tool}`)
  }
  await Promise.all(
    phases.map(async (phase) => {
      // Only the manifest protocol changes. Exact executable/store pins stay untouched.
      const selectedTool =
        phase === 'selected' ? 'bun' : phase === 'unused' ? 'coreutils-readlink' : phase
      const current = manifests.map((manifest) =>
        manifest.toolId === selectedTool
          ? { ...manifest, protocol: `${manifest.protocol}/identity-proof-${phase}` }
          : manifest,
      )
      const files = current.flatMap((manifest) => [
        {
          path: `${platform}/${manifest.toolId}/BUCK`,
          bytes:
            manifest.runtimeContract === 'immutable-directory/v1'
              ? capabilityDirectoryBuckBytes
              : capabilityToolBuckBytes,
        },
        {
          path: `${platform}/${manifest.toolId}/manifest.json`,
          bytes: `${JSON.stringify(manifest)}\n`,
        },
      ])
      const generation = computeCapabilityProjectionGeneration(files)
      const profile = join(destination, phase)
      await mkdir(profile, { recursive: true })
      await Promise.all([
        writeFile(join(profile, 'BUCK'), '# Disposable identity-proof projection.\n'),
        writeFile(
          join(profile, 'defs.bzl'),
          renderCapabilityProjectionDefs({ generation, platform, manifests: current }),
        ),
        ...current.map(async (manifest) => {
          const directory = join(
            profile,
            'tools',
            platform,
            manifest.toolId,
            capabilityManifestDigest(manifest),
          )
          await mkdir(directory, { recursive: true })
          const isDirectory = manifest.runtimeContract === 'immutable-directory/v1'
          await Promise.all([
            writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`),
            writeFile(
              join(directory, 'BUCK'),
              isDirectory === true ? capabilityDirectoryBuckBytes : capabilityToolBuckBytes,
            ),
            symlink(
              isDirectory === true ? manifest.directoryStorePath : manifest.executableStorePath,
              join(directory, isDirectory === true ? 'directory' : 'executable'),
            ),
          ])
        }),
      ])
    }),
  )
  const node = manifests.find((manifest) => manifest.toolId === 'node')
  if (node === undefined || node.runtimeContract !== 'native-executable/v1')
    throw new Error('node executable capability required')
  await writeFile(join(destination, 'node-store-path'), node.executableStorePath)
}

if (import.meta.main === true) {
  const [command, source, destination, option] = process.argv.slice(2)
  if (source === undefined || source === '' || destination === undefined || destination === '')
    throw new Error(
      'usage: bun buck2-capability-identity-proof.ts prepare SOURCE PROFILES | assert LOGS OUTPUT [--require-remote-hits]',
    )
  if (command === 'prepare') {
    await prepareProfiles({ source, destination })
  } else if (command === 'assert') {
    const observations = {
      baseline: identityActions(await readFile(join(source, 'baseline.jsonl'), 'utf8')),
      selected: identityActions(await readFile(join(source, 'selected.jsonl'), 'utf8')),
      unused: identityActions(await readFile(join(source, 'unused.jsonl'), 'utf8')),
      'action-env': identityActions(await readFile(join(source, 'action-env.jsonl'), 'utf8')),
    }
    assertIdentity({ observations, requireRemoteHits: option === '--require-remote-hits' })
    const dependencyExecution = identityActions(
      await readFile(join(source, 'dependency.jsonl'), 'utf8'),
    )
    assertDependencyExecution(dependencyExecution)
    await writeFile(
      destination,
      `${JSON.stringify({ schema: 'effect-utils/buck2-capability-identity-proof/v1', passed: true, selectedTool: 'bun', unusedTool: 'coreutils-readlink', actionEnvTool: 'action-env', requireRemoteHits: option === '--require-remote-hits', observations, dependencyExecution }, null, 2)}\n`,
    )
    console.log(
      `Capability identity and executable dependency proof passed; evidence: ${destination}`,
    )
  } else {
    throw new Error(`unknown proof command: ${command}`)
  }
}
