import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

const vanished = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')

const inaccessibleProcessEntry = (error: unknown): boolean =>
  vanished(error) === true ||
  (error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM'))

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
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
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
}: {
  readonly editorRoot: string
  readonly repoRoot?: string
}): ReadonlySet<string> | undefined => {
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
  // Package first hops live outside the editor root. Do not follow workspace
  // member links or descend into dependency/build payloads while locating them.
  const packages = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.name === 'node_modules') {
        if (entry.isSymbolicLink() === true) pointer(path)
        continue
      }
      if (
        entry.isDirectory() === true &&
        entry.name.startsWith('.') === false &&
        entry.name !== 'buck-out' &&
        entry.name !== 'repos' &&
        entry.name !== 'dist' &&
        entry.name !== 'result'
      )
        packages(path)
    }
  }
  try {
    controls(editorRoot)
    if (repoRoot !== undefined) packages(repoRoot)
    return referenced
  } catch {
    return undefined
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
  return observeProcessReferences({ admit, strict: false }) === true ? referenced : undefined
}

const observeProcessReferences = ({
  admit,
  strict,
}: {
  readonly admit: (target: string) => void
  readonly strict: boolean
}): boolean | undefined => {
  const ignorable = (error: unknown): boolean =>
    strict === true ? vanished(error) : inaccessibleProcessEntry(error)
  if (process.platform === 'linux') {
    try {
      for (const pid of readdirSync('/proc')) {
        if (/^[0-9]+$/.test(pid) === false) continue
        const directory = join('/proc', pid)
        try {
          // Publication is user-owned; only same-user process references are
          // advisory evidence. Managed pins do not depend on process visibility.
          if (lstatSync(directory).uid !== process.getuid?.()) continue
          for (const entry of ['exe', 'cwd', 'root']) {
            try {
              admit(readlinkSync(join(directory, entry)))
            } catch (error) {
              if (ignorable(error) === false) throw error
            }
          }
          try {
            for (const fd of readdirSync(join(directory, 'fd'))) {
              try {
                admit(readlinkSync(join(directory, 'fd', fd)))
              } catch (error) {
                if (ignorable(error) === false) throw error
              }
            }
          } catch (error) {
            if (ignorable(error) === false) throw error
          }
          for (const entry of ['maps', 'cmdline']) {
            try {
              const content = readFileSync(join(directory, entry), 'utf8')
              if (entry === 'maps') {
                for (const line of content.split('\n')) {
                  const pathname = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line)?.[1]
                  if (pathname !== undefined) admit(pathname)
                }
              } else {
                // A JS process may load its entry point and close that descriptor.
                for (const argument of content.split('\0'))
                  if (argument.startsWith('/') === true) admit(argument)
              }
            } catch (error) {
              if (ignorable(error) === false) throw error
            }
          }
        } catch (error) {
          if (ignorable(error) === false) return undefined
        }
      }
    } catch {
      return undefined
    }
    return true
  }
  if (process.platform === 'darwin') {
    // Native lsof is the macOS kernel-reader interface; no ambient PATH lookup.
    const result = spawnSync('/usr/sbin/lsof', ['-nP', '-Fn', '-u', String(process.getuid?.())], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) return undefined
    for (const line of result.stdout.split('\n'))
      if (line.startsWith('n/') === true) admit(line.slice(1))
    return true
  }
  return undefined
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

type ProcessCandidateGroup = { readonly indices: number[]; remaining: number }

/**
 * Return only candidates positively held by same-user cwd, descriptors or
 * mappings. Known snapshot paths protect only that candidate; all other paths
 * in an editor root, including `.store` and unidentified children, protect every
 * candidate in that root. Shared payload inodes protect every linking candidate,
 * even through a canonical CAS path or external alias.
 *
 * Containment is lexical: this observation never walks symlinks. Uninspectable
 * processes contribute nothing, so managed pins and root recency remain the
 * protection for readers outside the kernel observations available here.
 */
export const observeEditorViewProcessCandidates = ({
  candidates,
}: {
  readonly candidates: readonly EditorViewProcessCandidate[]
}): ReadonlySet<string> => {
  const held = new Set<string>()
  const uid = process.getuid?.()
  if (
    candidates.length === 0 ||
    uid === undefined ||
    (process.platform !== 'linux' && process.platform !== 'darwin')
  )
    return held

  const heldCandidates = new Uint8Array(candidates.length)
  const hasInodes = new Uint8Array(candidates.length)
  let remaining = candidates.length
  let remainingWithInodes = 0
  const roots = new Map<string, ProcessCandidateGroup>()
  const snapshots = new Map<string, ProcessCandidateGroup>()
  // Keep each distinct inode once, with numeric candidate associations rather
  // than retaining duplicate inode strings or a per-generation reverse index.
  // Index inode number first so irrelevant mappings need no device conversion.
  const inodes = new Map<string, Map<string, number[]>>()
  for (const [index, candidate] of candidates.entries()) {
    let root = roots.get(candidate.editorRoot)
    if (root === undefined) {
      root = { indices: [], remaining: 0 }
      roots.set(candidate.editorRoot, root)
    }
    root.indices.push(index)
    root.remaining++
    let snapshot = snapshots.get(candidate.snapshotRoot)
    if (snapshot === undefined) {
      snapshot = { indices: [], remaining: 0 }
      snapshots.set(candidate.snapshotRoot, snapshot)
    }
    snapshot.indices.push(index)
    snapshot.remaining++
    for (const inode of candidate.linkedInodes) {
      if (hasInodes[index] === 0) {
        hasInodes[index] = 1
        remainingWithInodes++
      }
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
      if (heldCandidates[index] !== 0) continue
      const candidate = candidates[index]
      if (candidate === undefined) continue
      heldCandidates[index] = 1
      remaining--
      if (hasInodes[index] === 1) remainingWithInodes--
      held.add(candidate.key)
      const root = roots.get(candidate.editorRoot)
      if (root !== undefined && --root.remaining === 0) roots.delete(candidate.editorRoot)
      const snapshot = snapshots.get(candidate.snapshotRoot)
      // Keep known snapshot identities after holding them: another reference to
      // the same generation must not be mistaken for an unidentified root path.
      if (snapshot !== undefined) snapshot.remaining--
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
    // Every candidate associated with this observed inode is now held.
    devices.delete(device)
    if (devices.size === 0) inodes.delete(number)
  }

  const admitPath = (target: string): void => {
    if (target.startsWith('/') === false) return
    const path = target.endsWith(' (deleted)') === true ? target.slice(0, -10) : target
    let ancestor = path
    // Look up ancestors, rather than comparing every observed path to every root.
    for (;;) {
      const snapshot = snapshots.get(ancestor)
      if (snapshot !== undefined) {
        if (snapshot.remaining !== 0) hold(snapshot.indices)
        return
      }
      hold(roots.get(ancestor)?.indices)
      if (remaining === 0 || ancestor === '/') return
      const separator = ancestor.lastIndexOf('/')
      ancestor = separator === 0 ? '/' : ancestor.slice(0, separator)
    }
  }

  const devices = new Map<string, string>()
  if (process.platform === 'linux') {
    let pids: string[] = []
    try {
      pids = readdirSync('/proc')
    } catch {}
    for (const pid of pids) {
      if (/^[0-9]+$/.test(pid) === false) continue
      const base = join('/proc', pid)
      try {
        if (lstatSync(base).uid !== uid) continue
      } catch {
        continue
      }
      try {
        admitPath(readlinkSync(join(base, 'cwd')))
      } catch {}
      if (remaining === 0) return held
      const fdDirectory = join(base, 'fd')
      let descriptors: string[] = []
      try {
        descriptors = readdirSync(fdDirectory)
      } catch {}
      for (const descriptor of descriptors) {
        const path = join(fdDirectory, descriptor)
        try {
          const target = readlinkSync(path)
          // Sockets, pipes and anonymous descriptors cannot link payload inodes.
          if (target.startsWith('/') === false) continue
          admitPath(target)
          if (remaining === 0) return held
          if (remainingWithInodes === 0) continue
          // Inspect the descriptor, not its pathname: deleted files and external
          // aliases still hold the same regular inode as a candidate payload.
          const status = statSync(path, { bigint: true })
          if (status.isFile() === true)
            holdInode({ number: String(status.ino), device: String(status.dev) })
          if (remaining === 0) return held
        } catch {}
      }
      let maps = ''
      try {
        maps = readFileSync(join(base, 'maps'), 'utf8')
      } catch {}
      for (const line of maps.split('\n')) {
        const match = /^\S+\s+\S+\s+\S+\s+([0-9a-f]+:[0-9a-f]+)\s+([0-9]+)\s*/.exec(line)
        if (match === null || match[1] === undefined || match[2] === undefined) continue
        const linked = remainingWithInodes === 0 ? undefined : inodes.get(match[2])
        if (linked !== undefined) {
          const encoded = match[1]
          let device = devices.get(encoded)
          if (device === undefined) {
            const separator = encoded.indexOf(':')
            device = String(
              linuxDevice({
                major: BigInt(`0x${encoded.slice(0, separator)}`),
                minor: BigInt(`0x${encoded.slice(separator + 1)}`),
              }),
            )
            devices.set(encoded, device)
          }
          holdInode({ number: match[2], device })
          if (remaining === 0) return held
        }
        // Anonymous mappings have no pathname; retain no irrelevant host paths.
        if (line[match[0].length] === '/') admitPath(line.slice(match[0].length))
        if (remaining === 0) return held
      }
    }
  } else {
    // Native lsof reports each kernel file's pathname and device/inode together.
    // Do not stat its name: CAS descriptors can have another hardlink spelling,
    // and deleted descriptors can have no surviving pathname at all.
    const user = String(uid)
    const result = spawnSync('/usr/sbin/lsof', ['-nP', '-FpuftDin0', '-u', user], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
    let sameUser = false
    let descriptor = ''
    let type = ''
    let device = ''
    let inode = ''
    let path = ''
    const admitFile = (): void => {
      if (
        sameUser === false ||
        descriptor.length === 0 ||
        descriptor === 'rtd' ||
        (type !== 'REG' && type !== 'DIR')
      )
        return
      admitPath(path)
      if (remaining === 0 || remainingWithInodes === 0 || type !== 'REG') return
      const linked = inodes.get(inode)
      if (linked === undefined || /^0x[0-9a-f]+$/i.test(device) === false) return
      let decoded = devices.get(device)
      if (decoded === undefined) {
        decoded = String(BigInt(device))
        devices.set(device, decoded)
      }
      holdInode({ number: inode, device: decoded })
    }
    for (let field of result.stdout?.split('\0') ?? []) {
      // With NUL fields, lsof still separates process/file sets with a newline.
      if (field.startsWith('\n') === true) field = field.slice(1)
      const identifier = field[0]
      if (identifier === 'p' || identifier === 'f') {
        admitFile()
        if (remaining === 0) return held
        descriptor = identifier === 'f' ? field.slice(1) : ''
        type = ''
        device = ''
        inode = ''
        path = ''
        if (identifier === 'p') sameUser = false
      } else if (identifier === 'u') sameUser = field.slice(1) === user
      else if (identifier === 't') type = field.slice(1)
      else if (identifier === 'D') device = field.slice(1)
      else if (identifier === 'i') inode = field.slice(1)
      else if (identifier === 'n') path = field.slice(1)
    }
    admitFile()
  }
  return held
}
