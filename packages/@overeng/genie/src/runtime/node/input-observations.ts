import { createHash, randomBytes, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import path from 'node:path'

/** Stable reasons why a recorded input closure cannot be proven complete. */
export const reasonCodes = [
  'unmediated-fs',
  'unmediated-realpath',
  'subprocess',
  'network',
  'ambient-env',
  'dynamic-import',
  'native-addon',
  'unstable-observation',
  'capture-error',
  'unknown-capability',
] as const
/** A supported input-closure incompleteness reason code. */
export type ReasonCode = (typeof reasonCodes)[number]
/** An observed or unproven capability with source and generator attribution. */
export type InputReason = {
  code: ReasonCode
  operation: string
  detail: string
  source: { module: string; line: number | null }
  generators: readonly string[]
  evidence: 'observed' | 'unproven'
}
/** Filesystem entry kinds represented in input evidence. */
export type EntryType =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'socket'
  | 'fifo'
  | 'character-device'
  | 'block-device'
type Missing = { state: 'absent'; error: 'ENOENT' | 'ENOTDIR' }
type Attributed = { by: readonly string[] }
/** Recorded file bytes or the error proving their absence. */
export type FileObservation = { path: string } & Attributed &
  ({ state: 'present'; digest: string; byteLength: number } | Missing)
/** Recorded directory inventory or the error proving its absence. */
export type DirectoryObservation = { path: string } & Attributed &
  ({ state: 'present'; entries: { name: string; type: EntryType }[]; digest: string } | Missing)
/** Recorded symlink target or the error proving its absence. */
export type SymlinkObservation = { path: string } & Attributed &
  ({ state: 'present'; target: string } | Missing)
/** Environment presence and invocation-salted value evidence. */
export type EnvObservation = { name: string } & Attributed &
  ({ present: false } | { present: true; digest: string })
/** Exact stat metadata with explicit symlink-following semantics. */
export type StatObservation = { path: string; followSymlinks: boolean } & Attributed &
  ({ state: 'present'; type: EntryType; values: Record<string, string> } | Missing)
/** A source file's path and content digest. */
export type CodeFile = { path: string; digest: string }
/** Version and source bytes identifying an implementation. */
export type Identity = { version: string; files: CodeFile[] }
/** Generator identity and the digest of its checked output. */
export type GeneratorResult = {
  generator: string
  target: string
  module: Identity
  outputDigest: string
}
/** Module resolution outcome and the inputs influencing it. */
export type ResolutionObservation = {
  importer: string
  specifier: string
  by: readonly string[]
  outcome:
    | { kind: 'file'; lexical: string; physical: string }
    | { kind: 'builtin'; name: string }
    | { kind: 'missing' }
  candidates: { kind: 'file' | 'directory'; path: string }[]
  contextEnv: string[]
  resolverCode: CodeFile[]
}

/** RFC 8785 key ordering; observation values contain only finite integers and Unicode strings. */
export const canonicalJson = (value: unknown): string => {
  if (typeof value === 'string' && value.isWellFormed() === false)
    throw new Error('Unrepresentable Unicode input')
  if (typeof value === 'number' && Number.isFinite(value) === false)
    throw new Error('Non-finite canonical JSON number')
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('Unsupported canonical JSON value')
    return encoded
  }
  if (Array.isArray(value) === true) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => `${canonicalJson(key)}:${canonicalJson(Reflect.get(value, key))}`)
    .join(',')}}`
}
/** Compare strings by UTF-8 bytes for deterministic evidence ordering. */
// oxlint-disable-next-line overeng/named-args -- Array comparators require two positional arguments.
export const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right))
/** Hash raw bytes or UTF-8 text with the evidence digest algorithm. */
export const digestBytes = (bytes: string | Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`
/** Hash a directory inventory using its domain-separated encoding. */
export const directoryDigest = (entries: { name: string; type: EntryType }[]): string =>
  digestBytes(`genie-directory-v1\n${canonicalJson(entries.map(({ name, type }) => [name, type]))}`)
/** Hash an environment value with its invocation salt and variable name. */
export const environmentDigest = ({
  salt,
  name,
  value,
}: {
  salt: string
  name: string
  value: string
}): string => digestBytes(canonicalJson(['genie-env-v1', salt, name, value]))
/** Classify a Node filesystem stat or directory entry. */
export const entryType = (
  entry: fs.Stats | fs.BigIntStats | fs.Dirent<string | Buffer>,
): EntryType => {
  if (entry.isFile() === true) return 'file'
  if (entry.isDirectory() === true) return 'directory'
  if (entry.isSymbolicLink() === true) return 'symlink'
  if (entry.isSocket() === true) return 'socket'
  if (entry.isFIFO() === true) return 'fifo'
  if (entry.isCharacterDevice() === true) return 'character-device'
  if (entry.isBlockDevice() === true) return 'block-device'
  throw new Error('Unsupported filesystem entry type')
}
/** Convert expected missing-path errors into absence evidence. */
export const missingObservation = (cause: unknown): Missing | undefined => {
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'absent', error: code } : undefined
}
/** Encode exact bigint stat fields as decimal strings. */
export const statValues = (stat: fs.BigIntStats): Record<string, string> =>
  Object.fromEntries(
    [
      'dev',
      'ino',
      'mode',
      'nlink',
      'uid',
      'gid',
      'rdev',
      'size',
      'blksize',
      'blocks',
      'atimeNs',
      'mtimeNs',
      'ctimeNs',
      'birthtimeNs',
    ].map((key) => {
      const value: unknown = Reflect.get(stat, key)
      if (typeof value !== 'bigint') throw new Error('Exact bigint stat field unavailable')
      return [key, value.toString()]
    }),
  )

/** Mutable state shared by one serialized input-recording session. */
export type InputRecording = {
  paths: Set<string>
  generators: readonly string[]
  reasons: InputReason[]
  excluded: ReadonlySet<string>
  evidence?: {
    invocationId: string
    envSalt: string
    files: Map<string, FileObservation>
    directories: Map<string, DirectoryObservation>
    symlinks: Map<string, SymlinkObservation>
    environment: Map<string, EnvObservation>
    cwd: Map<string, { lexical: string; physical: string; by: readonly string[] }>
    stats: Map<string, StatObservation>
    generatorResults: Map<string, GeneratorResult>
    resolutions: Map<string, ResolutionObservation>
    genieVersion?: string
  }
}
/** Create a recording, optionally retaining digest-backed read-set evidence. */
export const makeInputRecording = ({
  digests = false,
  exclude = [],
}: { digests?: boolean; exclude?: readonly string[] } = {}): InputRecording => ({
  paths: new Set(),
  generators: [],
  reasons: [],
  excluded: new Set(exclude.map((input) => path.resolve(input))),
  ...(digests === true
    ? {
        evidence: {
          invocationId: randomUUID(),
          envSalt: randomBytes(32).toString('hex'),
          files: new Map(),
          directories: new Map(),
          symlinks: new Map(),
          environment: new Map(),
          cwd: new Map(),
          stats: new Map(),
          generatorResults: new Map(),
          resolutions: new Map(),
        },
      }
    : {}),
})
/** Retain an incompleteness reason unless identical evidence already exists. */
export const addReason = ({
  recording,
  reason,
}: {
  recording: InputRecording
  reason: InputReason
}): void => {
  if (recording.reasons.some((other) => canonicalJson(other) === canonicalJson(reason)) === false)
    recording.reasons.push(reason)
}
/** Mark a capture operation as unable to retain exact input evidence. */
export const captureFault = ({
  recording,
  operation,
  module,
}: {
  recording: InputRecording
  operation: string
  module: string
}): void =>
  addReason({
    recording,
    reason: {
      code: 'capture-error',
      operation,
      detail: 'Input evidence could not be captured exactly',
      source: { module, line: null },
      generators: [],
      evidence: 'observed',
    },
  })
/** Merge attribution for stable observations and report conflicting evidence. */
export const retainObservation = <TObservation extends Attributed>({
  recording,
  map,
  key,
  observation,
}: {
  recording: InputRecording
  map: Map<string, TObservation>
  key: string
  observation: TObservation
}): void => {
  const previous = map.get(key)
  if (
    previous !== undefined &&
    canonicalJson({ ...previous, by: [] }) !== canonicalJson({ ...observation, by: [] })
  ) {
    addReason({
      recording: recording,
      reason: {
        code: 'unstable-observation',
        operation: 'repeated input observation',
        detail: `Conflicting observations for ${key}`,
        source: { module: '@overeng/genie/src/runtime/node/input-observations.ts', line: null },
        generators: [],
        evidence: 'observed',
      },
    })
    return
  }
  map.set(
    key,
    previous === undefined
      ? observation
      : {
          ...observation,
          by: [...new Set([...previous.by, ...observation.by])].toSorted(compareUtf8),
        },
  )
}

/** Capture before consumption; wrappers also retain the bytes actually returned by reads. */
export const capturePath = ({
  recording,
  input,
}: {
  recording: InputRecording
  input: string
}): void => {
  if (recording.excluded.has(input) === true) return
  if (input.isWellFormed() === false) {
    captureFault({
      recording: recording,
      operation: 'inspect non-Unicode path',
      module: '@overeng/genie/src/runtime/node/input-observations.ts',
    })
    return
  }
  recording.paths.add(input)
  const evidence = recording.evidence
  if (evidence === undefined) return
  try {
    // Every traversed link matters, not only a link at the final path.
    const parsed = path.parse(input)
    let prefix = parsed.root
    for (const segment of input.slice(parsed.root.length).split(path.sep)) {
      prefix = path.join(prefix, segment)
      const entry = fs.lstatSync(prefix)
      if (entry.isSymbolicLink() === true) {
        const bytes = fs.readlinkSync(prefix, { encoding: 'buffer' })
        const target = bytes.toString('utf8')
        if (Buffer.from(target).equals(bytes) === false)
          throw new Error('Non-Unicode symlink target')
        retainObservation({
          recording: recording,
          map: evidence.symlinks,
          key: prefix,
          observation: { path: prefix, by: [], state: 'present', target },
        })
      } else if (evidence.symlinks.has(prefix) === true)
        addReason({
          recording: recording,
          reason: {
            code: 'unstable-observation',
            operation: 'resolve symlink',
            detail: `Previously traversed symlink was replaced: ${prefix}`,
            source: { module: '@overeng/genie/src/runtime/node/input-observations.ts', line: null },
            generators: [],
            evidence: 'observed',
          },
        })
    }
    const stat = fs.statSync(input, { bigint: true })
    if (
      (evidence.files.get(input)?.state === 'present' && stat.isFile() === false) ||
      (evidence.directories.get(input)?.state === 'present' && stat.isDirectory() === false)
    )
      addReason({
        recording: recording,
        reason: {
          code: 'unstable-observation',
          operation: 'input type',
          detail: `Input changed its filesystem type: ${input}`,
          source: { module: '@overeng/genie/src/runtime/node/input-observations.ts', line: null },
          generators: [],
          evidence: 'observed',
        },
      })
    if (stat.isFile() === true) {
      const bytes = fs.readFileSync(input)
      const after = fs.statSync(input, { bigint: true })
      if (
        ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(
          (key) => Reflect.get(stat, key) !== Reflect.get(after, key),
        ) === true
      )
        addReason({
          recording: recording,
          reason: {
            code: 'unstable-observation',
            operation: 'readFile',
            detail: `File changed while consumed: ${input}`,
            source: { module: '@overeng/genie/src/runtime/node/input-observations.ts', line: null },
            generators: [],
            evidence: 'observed',
          },
        })
      retainObservation({
        recording: recording,
        map: evidence.files,
        key: input,
        observation: {
          path: input,
          by: [],
          state: 'present',
          digest: digestBytes(bytes),
          byteLength: bytes.byteLength,
        },
      })
    } else if (stat.isDirectory() === true) {
      try {
        // Read raw names separately from types: Bun ignores withFileTypes when encoding is buffer.
        // lstat preserves symlink identity, while the byte round-trip still rejects invalid UTF-8.
        const entries = fs
          .readdirSync(input, { encoding: 'buffer' })
          .map((bytes) => {
            const name = bytes.toString('utf8')
            if (Buffer.from(name).equals(bytes) === false || name.isWellFormed() === false)
              throw new Error('Non-Unicode directory name')
            return { name, type: entryType(fs.lstatSync(path.join(input, name))) }
          })
          .toSorted((left, right) => compareUtf8(left.name, right.name))
        retainObservation({
          recording: recording,
          map: evidence.directories,
          key: input,
          observation: {
            path: input,
            by: [],
            state: 'present',
            entries,
            digest: directoryDigest(entries),
          },
        })
      } catch {
        // A missing listed child is not evidence that the parent directory is absent.
        evidence.directories.delete(input)
        captureFault({
          recording: recording,
          operation: `inspect directory inventory: ${input}`,
          module: '@overeng/genie/src/runtime/node/input-observations.ts',
        })
      }
    } else {
      retainObservation({
        recording: recording,
        map: evidence.stats,
        key: canonicalJson([input, true]),
        observation: {
          path: input,
          followSymlinks: true,
          by: [],
          state: 'present',
          type: entryType(stat),
          values: statValues(stat),
        },
      })
    }
  } catch (cause) {
    const missing = missingObservation(cause)
    if (missing === undefined)
      captureFault({
        recording: recording,
        operation: `inspect input: ${input}`,
        module: '@overeng/genie/src/runtime/node/input-observations.ts',
      })
    else {
      retainObservation({
        recording: recording,
        map: evidence.files,
        key: input,
        observation: { path: input, by: [], ...missing },
      })
      retainObservation({
        recording: recording,
        map: evidence.directories,
        key: input,
        observation: { path: input, by: [], ...missing },
      })
    }
  }
}
