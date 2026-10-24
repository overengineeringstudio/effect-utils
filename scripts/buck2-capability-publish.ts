import { dlopen } from 'bun:ffi'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const generationPattern = /^[0-9a-f]{64}$/u

/** Read only the generator's literal identity; never evaluate Starlark. */
export const capabilityGeneration = (defs: string): string => {
  const declarations = [...defs.matchAll(/^GENERATION\s*=/gmu)]
  const generation = /^GENERATION = "([0-9a-f]{64})"$/mu.exec(defs)?.[1]
  if (declarations.length !== 1 || generation === undefined)
    throw new Error('Capability projection must declare exactly one SHA-256 GENERATION')
  return generation
}

type Publication = { readonly generation: string; readonly sequence: number }

/** Re-publication updates recency; the currently selected generation is always retained. */
export const retainedCapabilityGenerations = ({
  publications,
  current,
}: {
  readonly publications: readonly Publication[]
  readonly current: string
}): ReadonlySet<string> =>
  new Set([
    current,
    ...publications
      .filter(({ generation }) => generation !== current)
      .toSorted(
        (left, right) =>
          right.sequence - left.sequence || left.generation.localeCompare(right.generation),
      )
      .slice(0, 2)
      .map(({ generation }) => generation),
  ])

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

const statIfPresent = (path: string): Stats | undefined => {
  try {
    return lstatSync(path)
  } catch (error) {
    if (isMissing(error) === true) return undefined
    throw error
  }
}

/**
 * The entire native boundary: BSD flock (LOCK_EX = 2), Linux renameat2
 * (AT_FDCWD = -100, RENAME_EXCHANGE = 2), Darwin renamex_np (RENAME_SWAP = 2).
 * Bun supplies no Node filesystem equivalent for these two operations. Buffers
 * are NUL-terminated and live for each synchronous call; closing the descriptor
 * releases flock, including on process death. Unsupported platforms fail closed.
 */
const nativePublication = () => {
  const platform = process.platform
  if (platform !== 'linux' && platform !== 'darwin')
    throw new Error(`Capability publication does not support ${platform}`)
  const lock = dlopen(platform === 'linux' ? 'libc.so.6' : '/usr/lib/libSystem.B.dylib', {
    flock: { args: ['i32', 'i32'], returns: 'i32' },
  })
  const exchange = ({ left, right }: { readonly left: string; readonly right: string }): void => {
    const leftBytes = Buffer.from(`${left}\0`)
    const rightBytes = Buffer.from(`${right}\0`)
    if (platform === 'linux') {
      const library = dlopen('libc.so.6', {
        renameat2: { args: ['i32', 'ptr', 'i32', 'ptr', 'u32'], returns: 'i32' },
      })
      try {
        if (library.symbols.renameat2(-100, leftBytes, -100, rightBytes, 2) !== 0)
          throw new Error(`Atomic capability cell exchange failed: ${left} <-> ${right}`)
      } finally {
        library.close()
      }
    } else {
      const library = dlopen('/usr/lib/libSystem.B.dylib', {
        renamex_np: { args: ['ptr', 'ptr', 'u32'], returns: 'i32' },
      })
      try {
        if (library.symbols.renamex_np(leftBytes, rightBytes, 2) !== 0)
          throw new Error(`Atomic capability cell exchange failed: ${left} <-> ${right}`)
      } finally {
        library.close()
      }
    }
  }
  return {
    acquire: (fd: number): void => {
      if (lock.symbols.flock(fd, 2) !== 0) throw new Error('Capability publication flock failed')
    },
    exchange,
    close: (): void => lock.close(),
  }
}

const atomicWrite = ({
  path,
  bytes,
}: {
  readonly path: string
  readonly bytes: string | Buffer
}): void => {
  const candidate = join(dirname(path), `.${randomUUID()}.candidate`)
  try {
    writeFileSync(candidate, bytes, { flag: 'wx', mode: 0o644 })
    renameSync(candidate, path)
  } finally {
    rmSync(candidate, { force: true })
  }
}

/** Only the exclusive publisher lock makes an interrupted atomic write abandoned. */
const cleanupAtomicWriteCandidates = (directory: string): void => {
  for (const name of readdirSync(directory)) {
    if (
      /^\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.candidate$/u.test(
        name,
      ) === false
    )
      continue
    const path = join(directory, name)
    if (lstatSync(path).isFile() === false)
      throw new Error(`Invalid abandoned capability atomic-write candidate: ${path}`)
    rmSync(path)
  }
}

const generationNames = (cell: string): string[] => {
  const directory = join(cell, 'generations')
  if (statIfPresent(directory) === undefined) return []
  if (lstatSync(directory).isDirectory() === false)
    throw new Error(`Capability generations must be a real directory: ${directory}`)
  return readdirSync(directory)
    .toSorted()
    .map((generation) => {
      if (
        generationPattern.test(generation) === false ||
        lstatSync(join(directory, generation)).isDirectory() === false
      )
        throw new Error(`Invalid immutable capability generation: ${generation}`)
      return generation
    })
}

/** References are publication metadata, never Buck action inputs. */
export const capabilityReferences = (value: unknown): readonly string[] => {
  if (
    Array.isArray(value) === false ||
    value.some(
      (path: unknown) =>
        typeof path !== 'string' ||
        /^tools\/[a-z0-9][a-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*\/[0-9a-f]{64}$/u.test(path) ===
          false,
    ) === true
  )
    throw new Error('Invalid capability tool reference set')
  return [...new Set<string>(value)].toSorted()
}

/** Union the action tool identities referenced by retained publication generations. */
export const retainedCapabilityTools = ({
  references,
  retained,
}: {
  readonly references: ReadonlyMap<string, readonly string[]>
  readonly retained: ReadonlySet<string>
}): ReadonlySet<string> =>
  new Set([...retained].flatMap((generation) => references.get(generation) ?? []))

const toolReferences = (cell: string): readonly string[] => {
  const tools = join(cell, 'tools')
  if (statIfPresent(tools) === undefined) return []
  const references: string[] = []
  for (const platform of readdirSync(tools).toSorted())
    for (const tool of readdirSync(join(tools, platform)).toSorted())
      for (const digest of readdirSync(join(tools, platform, tool)).toSorted())
        references.push(`tools/${platform}/${tool}/${digest}`)
  return capabilityReferences(references)
}

/** Copy metadata, not tool closures. Links stay exact absolute per-tool Nix paths. */
const copyGeneration = ({
  source,
  destination,
}: {
  readonly source: string
  readonly destination: string
}): void => {
  mkdirSync(destination)
  for (const name of readdirSync(source).toSorted()) {
    const from = join(source, name)
    const to = join(destination, name)
    const stat = lstatSync(from)
    if (stat.isDirectory() === true) copyGeneration({ source: from, destination: to })
    else if (stat.isFile() === true) copyFileSync(from, to)
    else if (stat.isSymbolicLink() === true) {
      const target = readlinkSync(from)
      if (isAbsolute(target) === false || (name !== 'executable' && name !== 'directory'))
        throw new Error(`Capability link must be an absolute per-tool store path: ${from}`)
      symlinkSync(target, to)
    } else throw new Error(`Unsupported capability projection entry: ${from}`)
  }
}

const equalGeneration = ({
  left,
  right,
}: {
  readonly left: string
  readonly right: string
}): boolean => {
  const leftNames = readdirSync(left).toSorted()
  const rightNames = readdirSync(right).toSorted()
  if (
    leftNames.length !== rightNames.length ||
    leftNames.some((name, index) => name !== rightNames[index]) === true
  )
    return false
  return leftNames.every((name) => {
    const from = join(left, name)
    const to = join(right, name)
    const a = lstatSync(from)
    const b = lstatSync(to)
    if (a.isDirectory() === true && b.isDirectory() === true)
      return equalGeneration({ left: from, right: to })
    if (a.isFile() === true && b.isFile() === true)
      return readFileSync(from).equals(readFileSync(to))
    return (
      a.isSymbolicLink() === true &&
      b.isSymbolicLink() === true &&
      readlinkSync(from) === readlinkSync(to)
    )
  })
}

const rootGeneration = ({
  nixStore,
  root,
  profile,
}: {
  readonly nixStore: string
  readonly root: string
  readonly profile: string
}): void => {
  const result = spawnSync(nixStore, ['--realise', '--add-root', root, '--indirect', profile], {
    encoding: 'utf8',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0)
    throw new Error(`Nix rooting failed for ${profile}: ${result.stderr.trim()}`)
  if (statIfPresent(root)?.isSymbolicLink() !== true || realpathSync(root) !== profile)
    throw new Error(`Nix did not establish the requested indirect capability root: ${root}`)
}

/**
 * Buck's invocation_paths.rs strips '/' from the absolute project root, then
 * adds its single-component isolation directory. daemon_dir.rs names buckd.pid.
 * Check every isolation, never process-scrape. Missing state root means no daemon;
 * existing but unreadable/incomplete state or an unprobeable PID is unknown.
 */
export const capabilityPruningDeferred = ({
  root,
  home = homedir(),
}: {
  readonly root: string
  readonly home?: string
}): boolean => {
  try {
    const state = join(home, '.buck', 'buckd', root.replace(/^\//u, ''))
    if (statIfPresent(state) === undefined) return false
    if (lstatSync(state).isDirectory() === false) return true
    for (const isolation of readdirSync(state)) {
      const directory = join(state, isolation)
      if (lstatSync(directory).isDirectory() === false) return true
      const pidPath = join(directory, 'buckd.pid')
      if (statIfPresent(pidPath)?.isFile() !== true) return true
      const contents = readFileSync(pidPath, 'utf8').trim()
      if (/^[1-9][0-9]*$/u.test(contents) === false) return true
      const pid = Number(contents)
      if (Number.isSafeInteger(pid) === false || pid > 2147483647) return true
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') continue
        return true
      }
    }
    return false
  } catch {
    return true
  }
}

/**
 * A symlink-to-directory cell transition changes the native watch topology.
 * Stop only this project's registered isolations, through Buck's lifecycle API.
 * Run after the complete new cell is visible: daemons starting after this
 * scan can only load the new root. A failed stop leaves the migration marker.
 */
const stopMigrationDaemons = ({
  roots,
  buck2,
}: {
  readonly roots: readonly string[]
  readonly buck2: string
}): readonly string[] => {
  const stopped: string[] = []
  for (const root of new Set(roots)) {
    const state = join(homedir(), '.buck', 'buckd', root.replace(/^\//u, ''))
    if (statIfPresent(state) === undefined) continue
    if (lstatSync(state).isDirectory() === false)
      throw new Error(`Cannot inspect capability migration daemon state: ${state}`)
    for (const isolation of readdirSync(state)) {
      if (lstatSync(join(state, isolation)).isDirectory() === false)
        throw new Error(`Invalid capability migration isolation state: ${join(state, isolation)}`)
      console.error(`Capability cell migration: stopping Buck daemon ${root} (${isolation})`)
      const result = spawnSync(buck2, ['--isolation-dir', isolation, 'kill'], {
        cwd: root,
        encoding: 'utf8',
      })
      if (result.error !== undefined) throw result.error
      if (result.status !== 0)
        throw new Error(
          `Buck daemon stop failed during capability cell migration (${isolation}): ${result.stderr.trim()}`,
        )
      stopped.push(`${root}:${isolation}`)
    }
  }
  return stopped
}

const publicationSequence = (receipt: string): number => {
  if (statIfPresent(receipt) === undefined) return 0
  const value: unknown = JSON.parse(readFileSync(receipt, 'utf8'))
  if (typeof value !== 'number' || Number.isSafeInteger(value) === false || value < 1)
    throw new Error(`Invalid capability publication receipt: ${receipt}`)
  return value
}

const makePrunedDirectoriesWritable = (path: string): void => {
  const stat = lstatSync(path)
  if (stat.isDirectory() === false) return
  if ((stat.mode & 0o200) === 0) chmodSync(path, stat.mode | 0o200)
  // lstat deliberately does not follow the per-tool Nix store links.
  for (const name of readdirSync(path)) makePrunedDirectoriesWritable(join(path, name))
}

const cleanupPrunedTrees = (trash: string): void => {
  for (const name of readdirSync(trash)) {
    makePrunedDirectoriesWritable(join(trash, name))
    rmSync(join(trash, name), { recursive: true, force: true })
  }
}

/** Selected generation, retention decision, and migration-only native daemon stops. */
export type CapabilityPublicationResult = {
  readonly generation: string
  readonly retainedCount: number
  readonly pruningDeferred: boolean
  readonly migrationDaemonStops: readonly string[]
}

/** Publish under one crash-released native lock; defs.bzl is the final watched write. */
export const publishCapabilities = ({
  root,
  profile,
  nixStore = 'nix-store',
  buck2 = process.env.BUCK2_BIN ?? 'buck2',
}: {
  readonly root: string
  readonly profile: string
  readonly nixStore?: string
  readonly buck2?: string
}): CapabilityPublicationResult => {
  const absoluteRoot = resolve(root)
  const projectRoot = realpathSync(absoluteRoot)
  const buckDirectory = join(projectRoot, '.buck2')
  mkdirSync(buckDirectory, { recursive: true })
  const native = nativePublication()
  const descriptor = openSync(join(buckDirectory, 'capabilities.lock'), 'a', 0o600)
  const candidate = join(buckDirectory, `capabilities.candidate.${randomUUID()}`)
  try {
    native.acquire(descriptor)
    cleanupAtomicWriteCandidates(buckDirectory)
    const incoming = realpathSync(profile)
    const defs = readFileSync(join(incoming, 'defs.bzl'))
    const generation = capabilityGeneration(defs.toString('utf8'))
    const incomingTools = toolReferences(incoming)
    const cell = join(buckDirectory, 'capabilities')
    const roots = join(buckDirectory, 'capability-roots')
    const receipts = join(buckDirectory, 'capability-publications')
    const referencesDirectory = join(buckDirectory, 'capability-references')
    const trash = join(buckDirectory, 'capability-trash')
    for (const directory of [roots, receipts, referencesDirectory, trash])
      mkdirSync(directory, { recursive: true })
    for (const directory of [receipts, referencesDirectory]) cleanupAtomicWriteCandidates(directory)
    const referencePath = (name: string): string => join(referencesDirectory, `${name}.json`)
    const references = new Map<string, readonly string[]>()
    for (const name of readdirSync(referencesDirectory)) {
      const identity = name.slice(0, -5)
      if (name.endsWith('.json') === false || generationPattern.test(identity) === false)
        throw new Error(`Invalid capability reference identity: ${name}`)
      references.set(
        identity,
        capabilityReferences(JSON.parse(readFileSync(referencePath(identity), 'utf8'))),
      )
    }
    const migrationMarker = join(buckDirectory, 'capabilities.migration')
    const existing = statIfPresent(cell)
    const migrating = existing?.isSymbolicLink() === true
    if (existing !== undefined && migrating === false && existing.isDirectory() === false)
      throw new Error(`Capability cell must be a real directory or legacy profile symlink: ${cell}`)
    if (existing?.isDirectory() === true) cleanupAtomicWriteCandidates(cell)
    const workingCell = existing === undefined || migrating === true ? candidate : cell
    if (migrating === true) {
      const previousProfile = realpathSync(cell)
      const previousCurrent = capabilityGeneration(
        readFileSync(join(previousProfile, 'defs.bzl'), 'utf8'),
      )
      // Root legacy paths only when unrooted. An interrupted same-generation
      // upgrade may already have committed a tools-layout root and references
      // while the live cell still points at the legacy profile. Never regress
      // that authoritative root: retained-tool restoration below needs it.
      for (const previous of new Set([previousCurrent, ...generationNames(previousProfile)])) {
        const previousRoot = join(roots, previous)
        if (statIfPresent(previousRoot) === undefined)
          rootGeneration({ nixStore, root: previousRoot, profile: previousProfile })
      }
      copyGeneration({ source: previousProfile, destination: candidate })
    } else if (workingCell === candidate) mkdirSync(candidate)
    if (existing !== undefined) {
      const previousCurrent = capabilityGeneration(
        readFileSync(join(workingCell, 'defs.bzl'), 'utf8'),
      )
      for (const previous of generationNames(workingCell)) {
        // Legacy action paths remain intact until retention AND the daemon lease
        // permit their removal; their profile roots continue protecting closures.
        if (references.has(previous) === false) references.set(previous, [])
      }
      if (references.has(previousCurrent) === false)
        references.set(previousCurrent, toolReferences(workingCell))
      for (const [previous, tools] of references) {
        if (statIfPresent(referencePath(previous)) === undefined)
          atomicWrite({ path: referencePath(previous), bytes: `${JSON.stringify(tools)}\n` })
      }
      const latest = Math.max(
        0,
        ...[...references.keys()].map((name) =>
          publicationSequence(join(receipts, `${name}.json`)),
        ),
      )
      const currentReceipt = join(receipts, `${previousCurrent}.json`)
      // Selected defs recover a crash between pointer publication and receipt.
      if (latest === 0 || publicationSequence(currentReceipt) !== latest) {
        if (Number.isSafeInteger(latest + 1) === false)
          throw new Error('Capability publication sequence exhausted')
        atomicWrite({ path: currentReceipt, bytes: `${latest + 1}\n` })
      }
    }
    const installTool = ({
      sourceProfile,
      tool,
    }: {
      readonly sourceProfile: string
      readonly tool: string
    }): void => {
      const source = join(sourceProfile, tool)
      const destination = join(workingCell, tool)
      const digest = tool.split('/').at(-1)
      if (
        createHash('sha256')
          .update(readFileSync(join(source, 'manifest.json')))
          .digest('hex') !== digest
      )
        throw new Error(`Capability manifest digest does not match tool path: ${tool}`)
      if (statIfPresent(destination) !== undefined) {
        if (equalGeneration({ left: source, right: destination }) === false)
          throw new Error(`Immutable capability tool has changed contents: ${tool}`)
      } else {
        mkdirSync(dirname(destination), { recursive: true })
        const toolCandidate = join(buckDirectory, `tool.candidate-${randomUUID()}`)
        try {
          copyGeneration({ source, destination: toolCandidate })
          renameSync(toolCandidate, destination)
        } finally {
          rmSync(toolCandidate, { recursive: true, force: true })
        }
      }
    }
    for (const [previous, tools] of references) {
      const rootPath = join(roots, previous)
      if (statIfPresent(rootPath)?.isSymbolicLink() !== true)
        throw new Error(`Retained capability generation has no Nix GC root: ${previous}`)
      const previousProfile = realpathSync(rootPath)
      rootGeneration({ nixStore, root: rootPath, profile: previousProfile })
      for (const tool of tools) installTool({ sourceProfile: previousProfile, tool })
    }
    const previousReferences = references.get(generation)
    const legacyGeneration = join(workingCell, 'generations', generation)
    const upgradingLegacy =
      previousReferences?.length === 0 && statIfPresent(legacyGeneration)?.isDirectory() === true
    if (upgradingLegacy === true) {
      // Layout alone does not change GENERATION. Verify the old per-tool
      // inputs before filling its reference set and moving its profile root.
      for (const tool of incomingTools) {
        const [, platform, toolId] = tool.split('/')
        if (
          equalGeneration({
            left: join(legacyGeneration, platform!, toolId!),
            right: join(incoming, tool),
          }) === false
        )
          throw new Error(`Immutable capability generation has changed references: ${generation}`)
      }
    } else if (
      previousReferences !== undefined &&
      JSON.stringify(previousReferences) !== JSON.stringify(incomingTools)
    ) {
      throw new Error(`Immutable capability generation has changed references: ${generation}`)
    }
    if (upgradingLegacy === true || statIfPresent(join(roots, generation)) === undefined)
      rootGeneration({ nixStore, root: join(roots, generation), profile: incoming })
    for (const tool of incomingTools) installTool({ sourceProfile: incoming, tool })
    references.set(generation, incomingTools)
    // Persist roots and references before the watched pointer, including on crash.
    atomicWrite({ path: referencePath(generation), bytes: `${JSON.stringify(incomingTools)}\n` })
    const rootBuck = readFileSync(join(incoming, 'BUCK'))
    if (statIfPresent(join(workingCell, 'BUCK')) === undefined)
      writeFileSync(join(workingCell, 'BUCK'), rootBuck, { flag: 'wx' })
    else if (readFileSync(join(workingCell, 'BUCK')).equals(rootBuck) === false)
      throw new Error('Capability root BUCK changed; immutable root contract cannot be replaced')
    if (existing === undefined) {
      writeFileSync(join(candidate, 'defs.bzl'), defs, { flag: 'wx' })
      renameSync(candidate, cell)
    } else {
      if (migrating === true) {
        // Persist the lifecycle obligation before changing the watch topology.
        atomicWrite({ path: migrationMarker, bytes: 'symlink-to-directory\n' })
        native.exchange({ left: candidate, right: cell })
      }
      if (migrating === true || readFileSync(join(cell, 'defs.bzl')).equals(defs) === false)
        atomicWrite({ path: join(cell, 'defs.bzl'), bytes: defs })
    }
    const migrationDaemonStops =
      statIfPresent(migrationMarker) === undefined
        ? []
        : stopMigrationDaemons({ roots: [projectRoot, absoluteRoot], buck2 })
    if (statIfPresent(migrationMarker) !== undefined) {
      rmSync(migrationMarker)
    }
    const publications = [...references.keys()].map((name) => ({
      generation: name,
      sequence: publicationSequence(join(receipts, `${name}.json`)),
    }))
    const sequence = Math.max(0, ...publications.map((publication) => publication.sequence)) + 1
    if (Number.isSafeInteger(sequence) === false)
      throw new Error('Capability publication sequence exhausted')
    // Receipts live outside the watched cell; only successful defs publication advances recency.
    atomicWrite({ path: join(receipts, `${generation}.json`), bytes: `${sequence}\n` })
    const pruningDeferred =
      capabilityPruningDeferred({ root: projectRoot }) ||
      (absoluteRoot !== projectRoot && capabilityPruningDeferred({ root: absoluteRoot }))
    const retained = retainedCapabilityGenerations({ publications, current: generation })
    if (pruningDeferred === false) {
      const retainedTools = retainedCapabilityTools({ references, retained })
      const detach = (path: string): void => {
        if (statIfPresent(path) !== undefined)
          renameSync(path, join(trash, `${randomUUID()}.pruned`))
      }
      // Detach whole immutable directories before deleting any metadata.
      for (const tool of toolReferences(cell))
        if (retainedTools.has(tool) === false) detach(join(cell, tool))
      for (const previous of generationNames(cell))
        if (retained.has(previous) === false) detach(join(cell, 'generations', previous))
      cleanupPrunedTrees(trash)
      for (const previous of references.keys()) {
        if (retained.has(previous) === true) continue
        rmSync(referencePath(previous), { force: true })
        rmSync(join(receipts, `${previous}.json`), { force: true })
        rmSync(join(roots, previous), { force: true })
      }
      // Recover a crash after reference deletion but before root/receipt removal.
      for (const previous of readdirSync(roots)) {
        if (generationPattern.test(previous) === true && retained.has(previous) === false) {
          rmSync(join(roots, previous), { force: true })
          rmSync(join(receipts, `${previous}.json`), { force: true })
        }
      }
    }
    return {
      generation,
      retainedCount: pruningDeferred === true ? publications.length : retained.size,
      pruningDeferred,
      migrationDaemonStops,
    }
  } finally {
    // Never sweep another publisher's candidates or unlink/recreate the live cell.
    try {
      rmSync(candidate, { recursive: true, force: true })
    } finally {
      closeSync(descriptor)
      native.close()
    }
  }
}

const main = (): void => {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      profile: { type: 'string' },
      'nix-store': { type: 'string' },
      buck2: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  if (values.root === undefined || values.profile === undefined)
    throw new Error(
      'Usage: bun scripts/buck2-capability-publish.ts --root ROOT --profile REALIZED_NIX_OUTPUT [--nix-store PATH] [--buck2 PATH]',
    )
  console.log(
    JSON.stringify(
      publishCapabilities({
        root: values.root,
        profile: values.profile,
        nixStore: values['nix-store'],
        buck2: values.buck2,
      }),
    ),
  )
}

if (import.meta.main === true) main()
