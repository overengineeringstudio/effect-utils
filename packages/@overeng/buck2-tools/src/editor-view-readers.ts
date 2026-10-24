import type { dlopen as openNativeLibrary } from 'bun:ffi'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import { isLinuxReaderInfrastructureIdentity } from './reader-infrastructure.ts'

/**
 * Integration-only enumeration dependency, inherited by real publication work.
 * The supplier includes the test process and its live children; all observations
 * still come from the kernel. No production entrypoint installs this context,
 * and no environment variable or command-line flag can narrow a production scan.
 */
export const editorViewProcessTestScope = new AsyncLocalStorage<() => readonly number[]>()

// Static import cannot work in portable Node consumers: bun:ffi is Bun-only.
const linuxDescriptorDirectory =
  typeof Bun !== 'undefined' ? await import('./editor-view-reader-directory.ts') : undefined

let darwinDeadVnodeProbe: ((pid: number, fd: number) => number) | undefined

/** Descriptor-local kernel proof, never an exemption for the owning process. */
export const editorViewDarwinDeadVnode: {
  readonly probe: (input: { readonly pid: number; readonly fd: number }) => boolean
} = {
  probe: ({ pid, fd }) => {
    if (
      process.platform !== 'darwin' ||
      typeof Bun === 'undefined' ||
      Number.isInteger(pid) === false ||
      pid <= 0 ||
      pid > 0x7fffffff ||
      Number.isInteger(fd) === false ||
      fd < 0 ||
      fd > 0x7fffffff
    )
      return false
    try {
      if (darwinDeadVnodeProbe === undefined) {
        const library = process.env.EDITOR_VIEW_LEASE_LIBRARY
        if (library === undefined || isAbsolute(library) === false) return false
        // Load only the packaged library and Bun's builtin FFI, never code from
        // an evictable editor view. Node-only census consumers remain portable.
        const { dlopen }: { readonly dlopen: typeof openNativeLibrary } = createRequire(
          import.meta.url,
        )('bun:ffi')
        darwinDeadVnodeProbe = dlopen(library, {
          eu_darwin_dead_vnode: { args: ['i32', 'i32'], returns: 'i32' },
        }).symbols.eu_darwin_dead_vnode
      }
      return darwinDeadVnodeProbe(pid, fd) === 1
    } catch {
      return false
    }
  },
}

let readerLeaseProbe: ((pid: number, fd: number, path: Uint8Array) => number) | undefined

/** Positive description-local proof; a pathname or another process's SH is insufficient. */
export const editorViewProcessLease = {
  probe: ({
    pid,
    fd,
    control,
  }: {
    readonly pid: string
    readonly fd: string
    readonly control: string
  }): boolean => {
    if (
      typeof Bun === 'undefined' ||
      /^\d+$/.test(pid) === false ||
      /^\d+$/.test(fd) === false ||
      Number(pid) <= 0 ||
      Number(pid) > 0x7fffffff ||
      Number(fd) > 0x7fffffff
    )
      return false
    try {
      if (readerLeaseProbe === undefined) {
        const library = process.env.EDITOR_VIEW_LEASE_LIBRARY
        if (library === undefined || isAbsolute(library) === false) return false
        const { dlopen }: { readonly dlopen: typeof openNativeLibrary } = createRequire(
          import.meta.url,
        )('bun:ffi')
        readerLeaseProbe = dlopen(library, {
          eu_reader_lease: { args: ['i32', 'i32', 'ptr'], returns: 'i32' },
        }).symbols.eu_reader_lease
      }
      return readerLeaseProbe(Number(pid), Number(fd), Buffer.from(`${control}\0`)) === 1
    } catch {
      return false
    }
  },
}

let darwinUnknownLogger: ((pid: number, fd: number) => void) | undefined

/** Observations for diagnosis only; logging must never change reader evidence. */
const logUnknownRecord = (record: {
  readonly pid: string | null
  readonly comm: string | null
  readonly fd: string | null
  readonly call: string
  readonly errno: string | number | null
}): void => {
  console.error(`editor-view-reader-unknown: ${JSON.stringify(record)}`)
  if (process.platform !== 'darwin') return
  if (record.pid === null || /^\d+$/.test(record.pid) === false || typeof Bun === 'undefined')
    return
  const pid = Number(record.pid)
  if (pid <= 0 || pid > 0x7fffffff) return
  const fd = record.fd !== null && /^\d+$/.test(record.fd) === true ? Number(record.fd) : -1
  if (fd > 0x7fffffff) return
  try {
    if (darwinUnknownLogger === undefined) {
      const library = process.env.EDITOR_VIEW_LEASE_LIBRARY
      if (library === undefined || isAbsolute(library) === false)
        throw new Error('packaged native diagnostic library is unavailable')
      const { dlopen }: { readonly dlopen: typeof openNativeLibrary } = createRequire(
        import.meta.url,
      )('bun:ffi')
      darwinUnknownLogger = dlopen(library, {
        eu_darwin_log_unknown: { args: ['i32', 'i32'], returns: 'void' },
      }).symbols.eu_darwin_log_unknown
    }
    darwinUnknownLogger(pid, fd)
  } catch (error) {
    console.error(
      `editor-view-reader-unknown: ${JSON.stringify({
        ...record,
        call: 'native-diagnostics',
        errno: failureErrno(error),
      })}`,
    )
  }
}

const vanished = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')

const failureCode = (error: unknown): string =>
  error instanceof Error && 'code' in error ? String(error.code) : String(error)

const failureErrno = (error: unknown): string | number | null =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (typeof error.code === 'string' || typeof error.code === 'number')
    ? error.code
    : null

/** Durable managed-reader contract, separate from advisory shell symlinks. */
export const editorViewPinSchema = 'effect-utils/editor-view-pin/v1' as const

/** Validated private registration naming the immutable generation a reader holds. */
export type EditorViewPinRecord = {
  readonly schema: typeof editorViewPinSchema
  readonly name: string
  readonly snapshot: string
}

/** Pin names are single portable path components shared by an editor state root. */
export const requireEditorViewPinName = (name: string): string => {
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) === false)
    throw new Error(`editor view: pin name must be a portable identifier without dots: ${name}`)
  return name
}

/** Decode a named registration; callers hold the content-store flock. */
export const readEditorViewPinRecord = ({
  path,
  name,
}: {
  readonly path: string
  readonly name: string
}): EditorViewPinRecord => {
  requireEditorViewPinName(name)
  if (lstatSync(path).isFile() === false)
    throw new Error(`editor view: managed pin must be a regular file: ${path}`)
  const fd = openSync(
    path,
    constants.O_RDONLY |
      constants.O_NONBLOCK |
      constants.O_NOFOLLOW |
      (process.platform === 'darwin' ? 0x1000000 : 0x80000),
  )
  let value: unknown
  try {
    const opened = fstatSync(fd)
    const named = lstatSync(path)
    if (opened.isFile() === false || opened.dev !== named.dev || opened.ino !== named.ino)
      throw new Error(`editor view: managed pin must be a regular file: ${path}`)
    value = JSON.parse(readFileSync(fd, 'utf8'))
  } finally {
    closeSync(fd)
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) === true ||
    Object.keys(value).toSorted().join(',') !== 'name,schema,snapshot' ||
    'schema' in value === false ||
    value.schema !== editorViewPinSchema ||
    'name' in value === false ||
    value.name !== name ||
    'snapshot' in value === false ||
    typeof value.snapshot !== 'string' ||
    /^\.store\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}-[0-9a-f]{64}$/.test(value.snapshot) === false
  )
    throw new Error(`editor view: managed pin does not conform to ${editorViewPinSchema}: ${path}`)
  return { schema: editorViewPinSchema, name, snapshot: value.snapshot }
}

/** Locked managed-pin inventory, or a preliminary observation tolerant of concurrent unpin. */
export const managedEditorViewSnapshots = ({
  editorRoot,
  advisory = false,
}: {
  readonly editorRoot: string
  readonly advisory?: boolean
}): ReadonlySet<string> => {
  const referenced = new Set<string>()
  const directory = join(editorRoot, '.pins')
  try {
    const status = lstatSync(directory)
    if (status.isDirectory() === false)
      throw new Error(`editor view: managed pins must be a real directory: ${directory}`)
  } catch (error) {
    if (vanished(error) === true) return referenced
    throw error
  }
  let files: string[]
  try {
    files = readdirSync(directory)
  } catch (error) {
    if (advisory === true && vanished(error) === true) return referenced
    throw error
  }
  for (const file of files) {
    if (file.endsWith('.json') === false) continue
    try {
      const record = readEditorViewPinRecord({
        path: join(directory, file),
        name: file.slice(0, -'.json'.length),
      })
      referenced.add(record.snapshot.slice('.store/'.length))
    } catch (error) {
      if (advisory === false || vanished(error) === false) throw error
    }
  }
  return referenced
}

/**
 * Observe pointers separately from payloads before orphan retirement. Lexical
 * targets preserve dangling legacy pointers; resolved targets catch indirect
 * links. Callers hold the root publication lock and repeat this observation at
 * their retirement fence. An unreadable pointer inventory never proves absence.
 */
export const referencedEditorViewPaths = ({
  editorRoot,
  repoRoot,
  onInventory,
}: {
  readonly editorRoot: string
  readonly repoRoot?: string | undefined
  readonly onInventory?: (observation: {
    readonly entries: number
    readonly durationMs: number
  }) => void
}): ReadonlySet<string> | undefined => {
  const inventoryStarted = performance.now()
  const referenced = new Set<string>()
  const pointer = (path: string): void => {
    if (lstatSync(path).isSymbolicLink() === false) return
    referenced.add(resolve(path, '..', readlinkSync(path)))
    try {
      referenced.add(realpathSync(path))
    } catch (error) {
      if (vanished(error) === false) throw error
    }
  }
  const controls = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink() === true) pointer(path)
      else if (entry.isDirectory() === true && entry.name === '.legacy') {
        // An exchanged first hop can itself be a symlink. It is a pointer
        // root, unlike links internal to a displaced dependency payload.
        for (const retained of readdirSync(path, { withFileTypes: true }))
          if (retained.isSymbolicLink() === true) pointer(join(path, retained.name))
      } else if (
        entry.isDirectory() === true &&
        entry.name !== '.store' &&
        entry.name !== '.legacy' &&
        entry.name.startsWith('.gc-') === false &&
        entry.name.startsWith('.publish.lock') === false
      )
        controls(path)
    }
  }
  // Package first hops may live under hidden/build/workspace directories too.
  // Walk real directories only (never follow workspace/dependency symlinks),
  // bounded by entries rather than silently declaring excluded inputs absent.
  // The editor root has its separate control-pointer inventory above.
  let packageEntries = 0
  const resolvedEditorRoot = resolve(editorRoot)
  const packages = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      packageEntries += 1
      if (packageEntries > 200_000)
        throw new Error('editor view: package pointer inventory exceeds its entry bound')
      const path = join(directory, name)
      const status = lstatSync(path)
      if (name === 'node_modules' && status.isSymbolicLink() === true) pointer(path)
      if (status.isDirectory() === false) continue
      // Real node_modules contents are dependency payload, not package first
      // hops; inspect the entry above but never inventory that payload tree.
      if (name === 'node_modules') continue
      // Git's object/index metadata contains no package first hops.
      if (name === '.git') continue
      // Editor payload stores are not package inputs. Each editor root has its
      // own control-pointer inventory; custom roots also match by exact path.
      if (name === '.editor-view' || path === resolvedEditorRoot) continue
      packages(path)
    }
  }
  try {
    controls(editorRoot)
    if (repoRoot !== undefined) packages(resolve(repoRoot))
    return referenced
  } catch {
    return undefined
  } finally {
    onInventory?.({ entries: packageEntries, durationMs: performance.now() - inventoryStarted })
  }
}

/**
 * This census is advisory: kernel references and shell symlinks can appear after
 * inspection, and permissions can hide readers. Guaranteed retention requires a
 * managed pin admitted under the content-store flock before using a generation.
 */
export const referencedEditorSnapshots = ({
  editorRoot,
  storeDir,
}: {
  readonly editorRoot: string
  readonly storeDir: string
}): ReadonlySet<string> | undefined => {
  const referenced = new Set<string>()
  const admit = (target: string): void => {
    if (target.startsWith('/') === false) return
    const path = target.endsWith(' (deleted)') === true ? target.slice(0, -10) : target
    const within = relative(storeDir, path)
    if (
      within === '..' ||
      within.startsWith(`..${sep}`) === true ||
      within.startsWith(sep) === true
    )
      return
    const snapshot = within.split(sep)[0]
    if (snapshot !== undefined && snapshot.length > 0) referenced.add(snapshot)
  }
  // Shell-created symlinks are advisory observations, not managed registrations.
  // Do not follow directory links: a link may point into a payload or another root.
  const pins = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (path === storeDir) continue
      try {
        const status = lstatSync(path)
        if (status.isSymbolicLink() === true) {
          admit(resolve(directory, readlinkSync(path)))
          try {
            admit(realpathSync(path))
          } catch (error) {
            if (vanished(error) === false) throw error
          }
        } else if (status.isDirectory() === true) pins(path)
      } catch (error) {
        // Managed registrations are atomically renamed while this advisory walk
        // runs outside the flock. A vanished observation is not a failed census.
        if (vanished(error) === false) throw error
      }
    }
  }
  pins(editorRoot)
  return scanEditorViewProcesses({ path: admit, inode: () => {} }).length === 0
    ? referenced
    : undefined
}

/** glibc `makedev` of a /proc maps `major:minor` field, matching `stat().dev`. */
const linuxDevice = ({
  major,
  minor,
}: {
  readonly major: bigint
  readonly minor: bigint
}): bigint =>
  ((major & 0xfffff000n) << 32n) |
  ((major & 0xfffn) << 8n) |
  ((minor & 0xffffff00n) << 12n) |
  (minor & 0xffn)

/**
 * One immutable generation considered for advisory eviction. Keys are unique;
 * roots are absolute, normalized paths, and linked inode identities use the
 * decimal `stat().dev:stat().ino` representation. The iterable is consumed once.
 */
export type EditorViewProcessCandidate = {
  readonly key: string
  readonly editorRoot: string
  readonly snapshotRoot: string
  readonly linkedInodes: Iterable<string>
}

type ProcessCandidateGroup = { readonly indices: number[] }
/** Candidate-scoped migration/lease proof and actionable blockers. */
export type EditorViewReaderEvidence = {
  readonly state: 'clear' | 'held' | 'unknown'
  readonly reasons: readonly string[]
  /** False preserves a positive candidate reference without claiming a complete census. */
  readonly scanComplete?: false
  /** False only after this referencing process proves its matching generation lease. */
  readonly unmanaged?: boolean
}

/**
 * Root-wide automatic-retirement policy. Callers must supply every immutable
 * generation in this root, not merely the generations selected for eviction.
 * Missing inventory/proof is unknown; a lease never overrides legacy evidence.
 */
export const editorViewAutomaticEvictionEvidence = ({
  editorRoot,
  candidates,
  evidence,
}: {
  readonly editorRoot: string
  readonly candidates?: readonly EditorViewProcessCandidate[]
  readonly evidence?: ReadonlyMap<string, EditorViewReaderEvidence>
}): EditorViewReaderEvidence => {
  if (candidates === undefined || evidence === undefined)
    return { state: 'unknown', reasons: [`root-process-proof-missing: ${editorRoot}`] }
  const applicable = candidates.filter((candidate) => candidate.editorRoot === editorRoot)
  if (applicable.length === 0)
    return { state: 'unknown', reasons: [`root-generation-inventory-empty: ${editorRoot}`] }
  const proofs: EditorViewReaderEvidence[] = applicable.map(
    ({ key }) =>
      evidence.get(key) ?? {
        state: 'unknown' as const,
        reasons: [`missing-process-classification: ${key}`],
      },
  )
  if (proofs.some((proof) => proof.state === 'unknown' || proof.scanComplete === false) === true)
    return {
      state: 'unknown',
      reasons: [...new Set(proofs.flatMap((proof) => proof.reasons))],
    }
  const held = proofs.filter((proof) => proof.state === 'held' && proof.unmanaged !== false)
  if (held.length !== 0)
    return {
      state: 'held',
      reasons: [
        `detected-unmanaged-editor-session: ${editorRoot}`,
        ...new Set(held.flatMap((proof) => proof.reasons)),
      ],
    }
  return { state: 'clear', reasons: [] }
}

/** Complete applicable migration evidence; held wins over incomplete evidence. */
export const classifyEditorViewProcessCandidates = ({
  candidates,
  processIds,
}: {
  readonly candidates: readonly EditorViewProcessCandidate[]
  /** Real-process integration scope only. Retirement callers MUST omit this. */
  readonly processIds?: readonly number[]
}): ReadonlyMap<string, EditorViewReaderEvidence> => {
  const held = new Map<string, EditorViewReaderEvidence>()
  let evidence = ''
  const processLeases = new Set<string>()
  const candidateControls = new Map(
    candidates.map((candidate) => [
      candidate.key,
      join(
        candidate.editorRoot,
        '.leases',
        `${candidate.snapshotRoot.slice(candidate.snapshotRoot.lastIndexOf('/') + 1)}.lock`,
      ),
    ]),
  )
  const controls = new Set(candidateControls.values())
  const finish = (reasons: readonly string[]): ReadonlyMap<string, EditorViewReaderEvidence> =>
    new Map<string, EditorViewReaderEvidence>(
      candidates.map(({ key }): [string, EditorViewReaderEvidence] => {
        const positive = held.get(key)
        return [
          key,
          positive === undefined
            ? { state: reasons.length === 0 ? 'clear' : 'unknown', reasons }
            : reasons.length === 0
              ? positive
              : { ...positive, scanComplete: false, reasons: [...positive.reasons, ...reasons] },
        ]
      }),
    )
  if (candidates.length === 0) return finish([])

  const roots = new Map<string, ProcessCandidateGroup>()
  const snapshots = new Map<string, ProcessCandidateGroup>()
  // Keep each distinct inode once, with numeric candidate associations rather
  // than retaining duplicate inode strings or a per-generation reverse index.
  // Index inode number first, then distinguish devices only for matching inodes.
  const inodes = new Map<string, Map<string, number[]>>()
  for (const [index, candidate] of candidates.entries()) {
    let root = roots.get(candidate.editorRoot)
    if (root === undefined) {
      root = { indices: [] }
      roots.set(candidate.editorRoot, root)
    }
    root.indices.push(index)
    let snapshot = snapshots.get(candidate.snapshotRoot)
    if (snapshot === undefined) {
      snapshot = { indices: [] }
      snapshots.set(candidate.snapshotRoot, snapshot)
    }
    snapshot.indices.push(index)
    for (const inode of candidate.linkedInodes) {
      const separator = inode.indexOf(':')
      const device = inode.slice(0, separator)
      const number = inode.slice(separator + 1)
      let devices = inodes.get(number)
      if (devices === undefined) {
        devices = new Map()
        inodes.set(number, devices)
      }
      let indices = devices.get(device)
      if (indices === undefined) {
        indices = []
        devices.set(device, indices)
      }
      // All entries for one candidate arrive together, so this also deduplicates
      // repeated payload hardlinks without a per-candidate string Set.
      if (indices.at(-1) !== index) indices.push(index)
    }
  }

  const hold = (indices: readonly number[] | undefined): void => {
    if (indices === undefined) return
    for (const index of indices) {
      const candidate = candidates[index]
      if (candidate === undefined) continue
      const unmanaged = processLeases.has(candidateControls.get(candidate.key) ?? '') === false
      const previous = held.get(candidate.key)
      if (previous?.unmanaged === true || (previous !== undefined && unmanaged === false)) continue
      held.set(candidate.key, { state: 'held', reasons: [evidence], unmanaged })
    }
  }

  const holdInode = ({
    number,
    device,
  }: {
    readonly number: string
    readonly device: string
  }): void => {
    const devices = inodes.get(number)
    const indices = devices?.get(device)
    if (devices === undefined || indices === undefined) return
    hold(indices)
  }

  const admitPath = (target: string): void => {
    if (target.startsWith('/') === false) return
    const path = target.endsWith(' (deleted)') === true ? target.slice(0, -10) : target
    // Protocol descriptors are control-plane evidence, not payload reachability.
    // In particular a SH lease for one generation cannot pin its siblings.
    for (const root of roots.keys())
      if (path === join(root, '.leases') || path.startsWith(`${join(root, '.leases')}/`) === true)
        return
    let ancestor = path
    // Look up ancestors, rather than comparing every observed path to every root.
    for (;;) {
      const snapshot = snapshots.get(ancestor)
      if (snapshot !== undefined) {
        hold(snapshot.indices)
        return
      }
      hold(roots.get(ancestor)?.indices)
      if (ancestor === '/') return
      const separator = ancestor.lastIndexOf('/')
      ancestor = separator === 0 ? '/' : ancestor.slice(0, separator)
    }
  }

  const reasons = scanEditorViewProcesses({
    beginProcess: ({ pid, descriptors }) => {
      processLeases.clear()
      for (const { fd, path } of descriptors) {
        if (
          controls.has(path) === true &&
          editorViewProcessLease.probe({ pid, fd, control: path }) === true
        )
          processLeases.add(path)
      }
    },
    path: (path, reason) => {
      evidence = reason
      admitPath(path)
    },
    inode: (number, device, reason) => {
      evidence = reason
      holdInode({ number, device })
    },
    ...(processIds === undefined ? {} : { processIds }),
  })
  return finish(reasons)
}

/** Compatibility API: unknown is blocking, never an absent positive reference. */
export const observeEditorViewProcessCandidates = (options: {
  readonly candidates: readonly EditorViewProcessCandidate[]
}): ReadonlySet<string> =>
  new Set(
    [...classifyEditorViewProcessCandidates(options)]
      .filter(([, evidence]) => evidence.state !== 'clear')
      .map(([key]) => key),
  )

type ProcessObserver = {
  readonly path: (path: string, reason: string) => void
  readonly inode: (number: string, device: string, reason: string) => void
  readonly beginProcess?: (input: {
    readonly pid: string
    readonly descriptors: readonly { readonly fd: string; readonly path: string }[]
  }) => void
}

type ProcessIncarnation = { readonly state: string; readonly startTime: string }

const processIncarnation = (base: string): ProcessIncarnation => {
  const stat = readFileSync(join(base, 'stat'), 'utf8')
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)
  const state = fields[0]
  const startTime = fields[19]
  if (
    startTime === undefined ||
    /^\d+$/.test(startTime) === false ||
    state === undefined ||
    /^[A-Za-z]$/.test(state) === false
  )
    throw new Error(`invalid process incarnation/state: ${base}/stat`)
  return { state, startTime }
}

/**
 * No namespace/cwd exclusion is sound without complete alias and outside-handle
 * evidence. Thus any unobservable same-user process applies to every root.
 */
const scanEditorViewProcesses = (
  observer: ProcessObserver & { readonly processIds?: readonly number[] },
): readonly string[] => {
  const processIds = observer.processIds ?? editorViewProcessTestScope.getStore()?.()
  const reasons: string[] = []
  if (
    processIds?.some((pid) => Number.isInteger(pid) === false || pid <= 0 || pid > 0x7fffffff) ===
    true
  ) {
    logUnknownRecord({
      pid: null,
      comm: null,
      fd: null,
      call: 'process-enumeration-scope',
      errno: null,
    })
    return ['invalid-process-enumeration-scope']
  }
  if (processIds?.length === 0) return []
  const uid = process.getuid?.()
  if (uid === undefined) {
    logUnknownRecord({ pid: null, comm: null, fd: null, call: 'process.getuid', errno: null })
    return ['process-uid-unavailable']
  }
  if (process.platform === 'linux') {
    let pids: string[]
    try {
      pids = processIds?.map(String) ?? readdirSync('/proc')
    } catch (error) {
      console.error('editor-view-process-census: allowlisted=0 unknown=1')
      logUnknownRecord({
        pid: null,
        comm: null,
        fd: null,
        call: 'readdir:/proc',
        errno: failureErrno(error),
      })
      return [`proc-enumeration: /proc: ${failureCode(error)}`]
    }
    let allowlisted = 0
    let unknown = 0
    for (const pid of pids) {
      if (/^\d+$/.test(pid) === false) continue
      const base = join('/proc', pid)
      const previousReasons = reasons.length
      let commObserved: string | null = null
      try {
        commObserved = readFileSync(join(base, 'comm'), 'utf8').trimEnd()
      } catch {}
      const logUnknown = ({
        call,
        error,
        fd = null,
      }: {
        readonly call: string
        readonly error?: unknown
        readonly fd?: string | null
      }): void =>
        logUnknownRecord({
          pid,
          comm: commObserved,
          fd,
          call,
          errno: failureErrno(error),
        })
      let identityCall = `lstat:${base}`
      let incarnation: ProcessIncarnation
      try {
        if (lstatSync(base).uid !== uid) {
          // Linux changes /proc ownership for nondumpable same-user processes.
          // Its readable status, rather than directory ownership, decides uid.
          identityCall = `readFile:${base}/status`
          const status = readFileSync(join(base, 'status'), 'utf8')
          const identity = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status)
          if (identity === null) throw new Error(`missing process uid: ${base}/status`)
          if (identity.slice(1).includes(String(uid)) === false) continue
        }
        identityCall = `readFile:${base}/stat`
        incarnation = processIncarnation(base)
        // A zombie/dead task has relinquished mm and fs_struct. Its visible PID
        // is positive exit evidence, not an opaque live reader.
        if (incarnation.state === 'Z' || incarnation.state === 'X' || incarnation.state === 'x')
          continue
      } catch (error) {
        if (vanished(error) === true) {
          try {
            const retry = processIncarnation(base)
            if (retry.state === 'Z' || retry.state === 'X' || retry.state === 'x') continue
          } catch (retryError) {
            if (vanished(retryError) === true) continue
          }
        }
        reasons.push(`proc-identity: ${base}: ${failureCode(error)}`)
        logUnknown({ call: identityCall, error })
        unknown++
        continue
      }
      const failures: { readonly path: string; readonly call: string; readonly error: unknown }[] =
        []
      let argumentsObserved: string[] | undefined
      try {
        const comm = commObserved ?? readFileSync(join(base, 'comm'), 'utf8').trimEnd()
        const cmdline = readFileSync(join(base, 'cmdline'), 'utf8').split('\0')
        while (cmdline.at(-1) === '') cmdline.pop()
        argumentsObserved = cmdline
        if (
          isLinuxReaderInfrastructureIdentity({
            platform: process.platform,
            comm,
            cmdline,
            uid,
            currentUid: uid,
          }) === true
        ) {
          if (processIncarnation(base).startTime !== incarnation.startTime) {
            reasons.push(`proc-incarnation-changed: ${base}; infrastructure identity changed`)
            logUnknown({ call: `readFile:${base}/stat` })
            unknown++
          } else allowlisted++
          continue
        }
      } catch {
        // A failed identity check grants no exemption. Ordinary complete
        // process observation below still determines applicability.
      }
      // Publish references only after the final incarnation proof: an exited
      // task no longer holds payloads, even if earlier inspection saw a handle.
      const paths: [string, string][] = []
      const inodes: [string, string, string][] = []
      const descriptors: { readonly fd: string; readonly path: string }[] = []
      let observationCall = ''
      const inspect = ({
        path,
        read,
      }: {
        readonly path: string
        readonly read: () => void
      }): void => {
        try {
          read()
        } catch (error) {
          failures.push({ path, call: observationCall, error })
        }
      }
      for (const entry of ['cwd', 'root', 'exe']) {
        const path = join(base, entry)
        inspect({
          path,
          read: () => {
            observationCall = `readlink:${path}`
            paths.push([readlinkSync(path), `proc-reference: ${path}`])
          },
        })
      }
      const fdDirectory = join(base, 'fd')
      inspect({
        path: fdDirectory,
        read: () => {
          const inspectDescriptor = (descriptor: string): void => {
            const path = join(fdDirectory, descriptor)
            inspect({
              path,
              read: () => {
                observationCall = `readlink:${path}`
                const target = readlinkSync(path)
                paths.push([target, `proc-reference: ${path}`])
                descriptors.push({ fd: descriptor, path: target })
                if (target.startsWith('/') === false) return
                observationCall = `stat:${path}`
                const status = statSync(path, { bigint: true })
                if (status.isFile() === true)
                  inodes.push([String(status.ino), String(status.dev), `proc-inode: ${path}`])
              },
            })
            observationCall =
              pid === String(process.pid)
                ? `opendir/readdir:${fdDirectory}`
                : `readdir:${fdDirectory}`
          }
          observationCall =
            pid === String(process.pid)
              ? `opendir/readdir:${fdDirectory}`
              : `readdir:${fdDirectory}`
          if (pid === String(process.pid)) {
            // A native handle must stay open: Bun's fs Dir can eagerly close
            // its enumeration fd even while the JS Dir object remains live.
            if (linuxDescriptorDirectory === undefined)
              throw new Error('native self-descriptor observation unavailable')
            linuxDescriptorDirectory.visitEditorViewProcessDescriptors({
              path: fdDirectory,
              visit: inspectDescriptor,
            })
          } else {
            for (const descriptor of readdirSync(fdDirectory)) inspectDescriptor(descriptor)
          }
        },
      })
      const maps = join(base, 'maps')
      inspect({
        path: maps,
        read: () => {
          observationCall = `readFile:${maps}`
          for (const line of readFileSync(maps, 'utf8').split('\n')) {
            if (line.length === 0) continue
            const match = /^\S+\s+\S+\s+\S+\s+([0-9a-f]+):([0-9a-f]+)\s+([0-9]+)\s*(.*)$/.exec(line)
            if (match === null) throw new Error(`incomplete maps record: ${maps}`)
            const [, major, minor, number, path] = match
            if (major === undefined || minor === undefined || number === undefined) continue
            inodes.push([
              number,
              String(
                linuxDevice({
                  major: BigInt(`0x${major}`),
                  minor: BigInt(`0x${minor}`),
                }),
              ),
              `proc-mapping: ${maps}`,
            ])
            if (path?.startsWith('/') === true) paths.push([path, `proc-mapping: ${maps}`])
          }
        },
      })
      const cmdline = join(base, 'cmdline')
      inspect({
        path: cmdline,
        read: () => {
          observationCall = `readFile:${cmdline}`
          for (const argument of argumentsObserved ?? readFileSync(cmdline, 'utf8').split('\0'))
            if (argument.startsWith('/') === true)
              paths.push([argument, `proc-command: ${cmdline}`])
        },
      })
      let exited = false
      try {
        const current = processIncarnation(base)
        exited = current.state === 'Z' || current.state === 'X' || current.state === 'x'
        if (current.startTime !== incarnation.startTime) {
          exited = true
          if (current.state !== 'Z' && current.state !== 'X' && current.state !== 'x') {
            reasons.push(
              `proc-incarnation-changed: ${base}; replacement process not completely observed`,
            )
            logUnknown({ call: `readFile:${base}/stat` })
          }
        }
      } catch (error) {
        // A missing fd/cwd is not proof of exit. A missing incarnation is.
        exited = vanished(error)
        if (exited === false) {
          reasons.push(`proc-incarnation-unavailable: ${base}: ${failureCode(error)}`)
          logUnknown({ call: `readFile:${base}/stat`, error })
        }
      }
      for (const failure of failures) {
        if (exited === true) continue
        reasons.push(
          `proc-incomplete: ${failure.path}: ${failureCode(failure.error)}; reachability unknown`,
        )
        logUnknown({
          call: failure.call,
          error: failure.error,
          fd: /\/fd\/(\d+)$/.exec(failure.path)?.[1] ?? null,
        })
      }
      if (exited === false) {
        observer.beginProcess?.({ pid, descriptors })
        for (const [path, reason] of paths) observer.path(path, reason)
        for (const [number, device, reason] of inodes) observer.inode(number, device, reason)
      }
      if (reasons.length !== previousReasons) unknown++
    }
    console.error(`editor-view-process-census: allowlisted=${allowlisted} unknown=${unknown}`)
    return reasons
  }
  if (process.platform !== 'darwin') return [`unsupported-process-platform: ${process.platform}`]
  let pid = ''
  let comm = ''
  let descriptor = ''
  const unknownRecord = ({
    reason,
    call,
    errno = null,
  }: {
    readonly reason: string
    readonly call: string
    readonly errno?: string | number | null
  }): void => {
    reasons.push(reason)
    logUnknownRecord({
      pid: pid.length === 0 ? null : pid,
      comm: comm.length === 0 ? null : comm,
      fd: descriptor.length === 0 ? null : descriptor,
      call,
      errno,
    })
  }
  const result = (() => {
    try {
      return spawnSync(
        '/usr/sbin/lsof',
        [
          '-nP',
          '-FpcuftDin0',
          '-u',
          String(uid),
          ...(processIds === undefined ? [] : ['-a', '-p', processIds.join(',')]),
        ],
        {
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024,
        },
      )
    } catch (error) {
      unknownRecord({
        reason: `lsof-spawn: ${failureCode(error)}`,
        call: 'lsof.spawn',
        errno: failureErrno(error),
      })
      return undefined
    }
  })()
  if (result === undefined) {
    console.error(`editor-view-process-census: deadVnode=0 unknown=${reasons.length}`)
    return reasons
  }
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (result.error !== undefined)
    unknownRecord({
      reason: `lsof-spawn: ${failureCode(result.error)}`,
      call: 'lsof.spawn',
      errno: failureErrno(result.error),
    })
  if (result.signal !== null)
    unknownRecord({ reason: `lsof-signal: ${result.signal}`, call: 'lsof.signal' })
  // lsof documents 1 for an empty selection. Accept it only with truly empty
  // output and no diagnostics; partial/nonempty output is not an empty scan.
  const empty = result.status === 1 && stdout.length === 0 && stderr.length === 0
  if (result.status !== 0 && empty === false)
    unknownRecord({ reason: `lsof-status: ${result.status}`, call: 'lsof.exit' })
  if (stderr.length !== 0)
    unknownRecord({ reason: `lsof-diagnostics: ${stderr.trim()}`, call: 'lsof.stderr' })
  if (stdout.length !== 0 && stdout.endsWith('\0') === false && stdout.endsWith('\0\n') === false)
    unknownRecord({ reason: 'lsof-incomplete: unterminated field output', call: 'lsof.fields' })
  if (stdout.length === 0 && result.status === 0)
    unknownRecord({
      reason: 'lsof-incomplete: successful scan without any process records',
      call: 'lsof.processes',
    })
  let sameUser = false
  let userKnown = false
  let processSeen = false
  let deadVnode = 0
  let type = ''
  let device = ''
  let inode = ''
  let path = ''
  const paths: [string, string][] = []
  const inodes: [string, string, string][] = []
  const descriptors: { readonly fd: string; readonly path: string }[] = []
  const finishProcess = (): void => {
    observer.beginProcess?.({ pid, descriptors })
    for (const [observedPath, reason] of paths) observer.path(observedPath, reason)
    for (const [number, observedDevice, reason] of inodes)
      observer.inode(number, observedDevice, reason)
    paths.length = 0
    inodes.length = 0
    descriptors.length = 0
  }
  const admit = (): void => {
    if (descriptor.length === 0) return
    if (userKnown === false) {
      unknownRecord({
        reason: `lsof-incomplete: missing process uid: ${descriptor}`,
        call: 'lsof.process-uid',
      })
      return
    }
    if (sameUser === false) return
    if (type.length === 0 || /unknown|UNKN|\?/.test(type) === true) {
      if (
        /^\d+$/.test(pid) === true &&
        /^\d+$/.test(descriptor) === true &&
        Number(pid) > 0 &&
        Number(pid) <= 0x7fffffff &&
        Number(descriptor) <= 0x7fffffff
      ) {
        try {
          if (
            editorViewDarwinDeadVnode.probe({ pid: Number(pid), fd: Number(descriptor) }) === true
          ) {
            deadVnode++
            return
          }
        } catch {
          // Missing or failed native evidence preserves the unknown record.
        }
      }
      unknownRecord({
        reason: `lsof-incomplete: missing/unknown file type: ${descriptor}`,
        call: 'lsof.file-type',
      })
      return
    }
    if (type !== 'REG' && type !== 'DIR') return
    const reason = `lsof-reference: ${descriptor}: ${path}`
    paths.push([path, reason])
    if (type !== 'REG') return
    if (/^0x[0-9a-f]+$/i.test(device) === false || /^\d+$/.test(inode) === false) {
      unknownRecord({
        reason: `lsof-incomplete: missing device/inode: ${descriptor}`,
        call: 'lsof.file-inode',
      })
      return
    }
    inodes.push([inode, String(BigInt(device)), reason])
    if (/^\d+$/.test(descriptor) === true) descriptors.push({ fd: descriptor, path })
  }
  for (let field of stdout.split('\0')) {
    if (field.startsWith('\n') === true) field = field.slice(1)
    const identifier = field[0]
    if (identifier === 'p' || identifier === 'f') {
      admit()
      descriptor = identifier === 'f' ? field.slice(1) : ''
      type = ''
      device = ''
      inode = ''
      path = ''
      if (identifier === 'p') {
        finishProcess()
        pid = field.slice(1)
        comm = ''
        processSeen = true
        if (/^\d+$/.test(field.slice(1)) === false)
          unknownRecord({ reason: 'lsof-incomplete: invalid process id', call: 'lsof.pid' })
        sameUser = false
        userKnown = false
      }
    } else if (identifier === 'u') {
      sameUser = field.slice(1) === String(uid)
      userKnown = /^\d+$/.test(field.slice(1))
    } else if (identifier === 'c') comm = field.slice(1)
    else if (identifier === 't') type = field.slice(1)
    else if (identifier === 'D') device = field.slice(1)
    else if (identifier === 'i') inode = field.slice(1)
    else if (identifier === 'n') path = field.slice(1)
    else if (field.length !== 0)
      unknownRecord({
        reason: `lsof-incomplete: unexpected field ${identifier}`,
        call: 'lsof.field',
      })
  }
  admit()
  finishProcess()
  if (stdout.length !== 0 && processSeen === false)
    unknownRecord({
      reason: 'lsof-incomplete: no process identity records',
      call: 'lsof.process-identity',
    })
  console.error(`editor-view-process-census: deadVnode=${deadVnode} unknown=${reasons.length}`)
  return reasons
}

/**
 * Read-only host measurement, intentionally separate from eviction policy.
 * Run: bun packages/@overeng/buck2-tools/src/editor-view-readers.ts ROOT [ROOT...]
 * No locks, markers, pins or payloads are created or changed.
 */
export const measureEditorViewReaders = async ({
  editorRoots,
}: {
  readonly editorRoots: readonly string[]
}): Promise<{
  readonly automaticEviction: {
    readonly eligibleRoots: number
    readonly noAutomaticEvictionRoots: number
    readonly detectedUnmanagedRoots: number
    readonly rootCounts: Readonly<Record<'clear' | 'held' | 'unknown', number>>
    readonly generationCounts: Readonly<Record<'clear' | 'held' | 'unknown', number>>
  }
  readonly roots: readonly {
    readonly editorRoot: string
    readonly policy: EditorViewReaderEvidence
    readonly reasons: readonly string[]
    readonly observed: EditorViewReaderEvidence
    readonly effective: EditorViewReaderEvidence
    readonly generationCounts: Readonly<Record<'clear' | 'held' | 'unknown', number>>
    readonly leaseControlInodes: number
    readonly leaseControlDirectoryInodes: number
    readonly leaseControlMetadataBytes: number
  }[]
  readonly generations: readonly {
    readonly editorRoot: string
    readonly snapshotRoot: string
    readonly legacy: EditorViewReaderEvidence
    readonly lease: EditorViewReaderEvidence & {
      readonly kind: 'held' | 'no-control' | 'clear' | 'unsafe'
    }
    readonly observed: EditorViewReaderEvidence
    readonly effective: EditorViewReaderEvidence
  }[]
}> => {
  // Keep native Bun FFI out of scanner-only imports and portable parser tests.
  const { observeEditorViewLeaseForRetirement } = await import('./editor-view-leases.ts')
  const candidates: EditorViewProcessCandidate[] = []
  const inventories = [...new Set(editorRoots.map((input) => resolve(input)))].map((editorRoot) => {
    const reasons: string[] = []
    let leaseControlInodes = 0
    let leaseControlDirectoryInodes = 0
    let leaseControlMetadataBytes = 0
    const controls = join(editorRoot, '.leases')
    try {
      const directory = lstatSync(controls)
      if (directory.isDirectory() === false)
        throw new Error(`lease controls are not a real directory: ${controls}`)
      leaseControlDirectoryInodes++
      leaseControlMetadataBytes += Math.max(directory.size, directory.blocks * 512)
      for (const name of readdirSync(controls)) {
        const status = lstatSync(join(controls, name))
        if (status.isFile() === false)
          throw new Error(`unsafe lease control: ${join(controls, name)}`)
        leaseControlInodes++
        leaseControlMetadataBytes += Math.max(status.size, status.blocks * 512)
      }
    } catch (error) {
      if (failureCode(error) !== 'ENOENT')
        reasons.push(`lease-control-inventory: ${controls}: ${failureCode(error)}`)
    }
    try {
      const store = join(editorRoot, '.store')
      for (const name of readdirSync(store)) {
        if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}-[0-9a-f]{64}$/.test(name) === false) continue
        const snapshotRoot = join(store, name)
        if (lstatSync(snapshotRoot).isDirectory() === false) continue
        const linkedInodes = new Set<string>()
        const walk = (directory: string): void => {
          for (const entry of readdirSync(directory)) {
            const path = join(directory, entry)
            const status = lstatSync(path, { bigint: true })
            if (status.isDirectory() === true) walk(path)
            else if (status.isFile() === true) linkedInodes.add(`${status.dev}:${status.ino}`)
          }
        }
        try {
          walk(snapshotRoot)
        } catch (error) {
          reasons.push(`generation-inventory: ${snapshotRoot}: ${failureCode(error)}`)
        }
        candidates.push({ key: snapshotRoot, editorRoot, snapshotRoot, linkedInodes })
      }
    } catch (error) {
      reasons.push(`root-inventory: ${editorRoot}: ${failureCode(error)}`)
    }
    return {
      editorRoot,
      reasons,
      leaseControlInodes,
      leaseControlDirectoryInodes,
      leaseControlMetadataBytes,
    }
  })
  const classified = classifyEditorViewProcessCandidates({ candidates })
  const roots = inventories.map((root) =>
    Object.assign({}, root, {
      policy: editorViewAutomaticEvictionEvidence({
        editorRoot: root.editorRoot,
        candidates,
        evidence: classified,
      }),
    }),
  )
  const generations = candidates.map(({ key, editorRoot, snapshotRoot }) => {
    const root = roots.find((entry) => entry.editorRoot === editorRoot)
    const legacy: EditorViewReaderEvidence = classified.get(key) ?? {
      state: 'unknown',
      reasons: ['missing-process-classification'],
    }
    // Diagnostic only: missing controls are conditionally clear because retirement
    // must backfill them under its owning CAS fence before retaining EX.
    const probe = observeEditorViewLeaseForRetirement({ editorRoot, snapshot: snapshotRoot })
    let lease: EditorViewReaderEvidence & {
      readonly kind: 'held' | 'no-control' | 'clear' | 'unsafe'
    }
    try {
      lease = { state: probe.state, kind: probe.kind, reasons: [...probe.reasons] }
    } finally {
      probe.release()
    }
    const observed: EditorViewReaderEvidence = {
      state:
        legacy.state === 'held' || lease.state === 'held'
          ? 'held'
          : legacy.state === 'unknown' || lease.state === 'unknown' || root?.reasons.length !== 0
            ? 'unknown'
            : 'clear',
      reasons: [
        ...legacy.reasons.map((reason) => `legacy: ${reason}`),
        ...lease.reasons.map((reason) => `lease: ${reason}`),
        ...(root?.reasons ?? []),
      ],
    }
    const policy = root?.policy ?? { state: 'unknown' as const, reasons: ['missing-root-policy'] }
    const effective: EditorViewReaderEvidence = {
      state:
        observed.state === 'held' || policy.state === 'held'
          ? 'held'
          : observed.state === 'unknown' || policy.state === 'unknown'
            ? 'unknown'
            : 'clear',
      reasons: [...new Set([...observed.reasons, ...policy.reasons])],
    }
    return { editorRoot, snapshotRoot, legacy, lease, observed, effective }
  })
  const measuredRoots = roots.map((root) => {
    const generationCounts = { clear: 0, held: 0, unknown: 0 }
    const reasons = [...root.reasons]
    for (const generation of generations) {
      if (generation.editorRoot !== root.editorRoot) continue
      generationCounts[generation.observed.state]++
      reasons.push(...generation.observed.reasons)
    }
    const observed: EditorViewReaderEvidence = {
      state:
        generationCounts.held > 0
          ? 'held'
          : generationCounts.unknown > 0 || root.reasons.length > 0
            ? 'unknown'
            : 'clear',
      reasons: [...new Set(reasons)],
    }
    const effective: EditorViewReaderEvidence = {
      state:
        observed.state === 'held' || root.policy.state === 'held'
          ? 'held'
          : observed.state === 'unknown' || root.policy.state === 'unknown'
            ? 'unknown'
            : 'clear',
      reasons: [...new Set([...observed.reasons, ...root.policy.reasons])],
    }
    return Object.assign({}, root, { observed, effective, generationCounts })
  })
  const rootCounts = { clear: 0, held: 0, unknown: 0 }
  const generationCounts = { clear: 0, held: 0, unknown: 0 }
  for (const root of measuredRoots) rootCounts[root.effective.state]++
  for (const generation of generations) generationCounts[generation.effective.state]++
  return {
    automaticEviction: {
      eligibleRoots: rootCounts.clear,
      noAutomaticEvictionRoots: rootCounts.held + rootCounts.unknown,
      detectedUnmanagedRoots: roots.filter((root) => root.policy.state === 'held').length,
      rootCounts,
      generationCounts,
    },
    roots: measuredRoots,
    generations,
  }
}

if (import.meta.main === true) {
  const editorRoots = process.argv.slice(2)
  if (editorRoots.length === 0) {
    console.error('Usage: bun editor-view-readers.ts EDITOR_ROOT [EDITOR_ROOT...] (read-only)')
    process.exitCode = 2
  } else console.log(JSON.stringify(await measureEditorViewReaders({ editorRoots }), undefined, 2))
}
