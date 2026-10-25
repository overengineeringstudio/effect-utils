import { createHash, randomBytes, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import path from 'node:path'

export const reasonCodes = [
  'unmediated-fs', 'unmediated-realpath', 'subprocess', 'network', 'ambient-env',
  'dynamic-import', 'native-addon', 'unstable-observation', 'capture-error', 'unknown-capability',
] as const
export type ReasonCode = (typeof reasonCodes)[number]
export type InputReason = {
  code: ReasonCode
  operation: string
  detail: string
  source: { module: string; line: number | null }
  generators: readonly string[]
  evidence: 'observed' | 'unproven'
}
export type EntryType = 'file' | 'directory' | 'symlink' | 'socket' | 'fifo' | 'character-device' | 'block-device'
type Missing = { state: 'absent'; error: 'ENOENT' | 'ENOTDIR' }
type Attributed = { by: readonly string[] }
export type FileObservation = { path: string } & Attributed & ({ state: 'present'; digest: string; byteLength: number } | Missing)
export type DirectoryObservation = { path: string } & Attributed & ({ state: 'present'; entries: { name: string; type: EntryType }[]; digest: string } | Missing)
export type SymlinkObservation = { path: string } & Attributed & ({ state: 'present'; target: string } | Missing)
export type EnvObservation = { name: string } & Attributed & ({ present: false } | { present: true; digest: string })
export type StatObservation = { path: string; followSymlinks: boolean } & Attributed & ({ state: 'present'; type: EntryType; values: Record<string, string> } | Missing)
export type CodeFile = { path: string; digest: string }
export type Identity = { version: string; files: CodeFile[] }
export type GeneratorResult = { generator: string; target: string; module: Identity; outputDigest: string }
export type ResolutionObservation = {
  importer: string
  specifier: string
  by: readonly string[]
  outcome: { kind: 'file'; lexical: string; physical: string } | { kind: 'builtin'; name: string } | { kind: 'missing' }
  candidates: { kind: 'file' | 'directory'; path: string }[]
  contextEnv: string[]
  resolverCode: CodeFile[]
}

/** RFC 8785 key ordering; observation values contain only finite integers and Unicode strings. */
export const canonicalJson = (value: unknown): string => {
  if (typeof value === 'string' && value.isWellFormed() === false) throw new Error('Unrepresentable Unicode input')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite canonical JSON number')
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('Unsupported canonical JSON value')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${canonicalJson(key)}:${canonicalJson(Reflect.get(value, key))}`).join(',')}}`
}
export const compareUtf8 = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right))
export const digestBytes = (bytes: string | Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
export const directoryDigest = (entries: { name: string; type: EntryType }[]): string =>
  digestBytes(`genie-directory-v1\n${canonicalJson(entries.map(({ name, type }) => [name, type]))}`)
export const environmentDigest = (salt: string, name: string, value: string): string =>
  digestBytes(canonicalJson(['genie-env-v1', salt, name, value]))
export const entryType = (entry: fs.Stats | fs.BigIntStats | fs.Dirent<string | Buffer>): EntryType => {
  if (entry.isFile()) return 'file'
  if (entry.isDirectory()) return 'directory'
  if (entry.isSymbolicLink()) return 'symlink'
  if (entry.isSocket()) return 'socket'
  if (entry.isFIFO()) return 'fifo'
  if (entry.isCharacterDevice()) return 'character-device'
  if (entry.isBlockDevice()) return 'block-device'
  throw new Error('Unsupported filesystem entry type')
}
export const missingObservation = (cause: unknown): Missing | undefined => {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'absent', error: code } : undefined
}
export const statValues = (stat: fs.BigIntStats): Record<string, string> => Object.fromEntries([
  'dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks',
  'atimeNs', 'mtimeNs', 'ctimeNs', 'birthtimeNs',
].map((key) => {
  const value: unknown = Reflect.get(stat, key)
  if (typeof value !== 'bigint') throw new Error('Exact bigint stat field unavailable')
  return [key, value.toString()]
}))

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
export const makeInputRecording = ({ digests = false, exclude = [] }: { digests?: boolean; exclude?: readonly string[] } = {}): InputRecording => ({
  paths: new Set(), generators: [], reasons: [], excluded: new Set(exclude.map((input) => path.resolve(input))),
  ...(digests ? { evidence: {
    invocationId: randomUUID(), envSalt: randomBytes(32).toString('hex'), files: new Map(), directories: new Map(),
    symlinks: new Map(), environment: new Map(), cwd: new Map(), stats: new Map(), generatorResults: new Map(), resolutions: new Map(),
  } } : {}),
})
export const addReason = (recording: InputRecording, reason: InputReason): void => {
  if (recording.reasons.some((other) => canonicalJson(other) === canonicalJson(reason)) === false) recording.reasons.push(reason)
}
export const captureFault = (recording: InputRecording, operation: string, module: string): void => addReason(recording, {
  code: 'capture-error', operation, detail: 'Input evidence could not be captured exactly',
  source: { module, line: null }, generators: [], evidence: 'observed',
})
export const retainObservation = <TObservation extends Attributed>(recording: InputRecording, map: Map<string, TObservation>, key: string, observation: TObservation): void => {
  const previous = map.get(key)
  if (previous !== undefined && canonicalJson({ ...previous, by: [] }) !== canonicalJson({ ...observation, by: [] })) {
    addReason(recording, { code: 'unstable-observation', operation: 'repeated input observation', detail: `Conflicting observations for ${key}`, source: { module: '@overeng/genie/src/runtime/node/input-observations.ts', line: null }, generators: [], evidence: 'observed' })
    return
  }
  map.set(key, previous === undefined ? observation : { ...observation, by: [...new Set([...previous.by, ...observation.by])].sort(compareUtf8) })
}

/** Capture before consumption; wrappers also retain the bytes actually returned by reads. */
export const capturePath = (recording: InputRecording, input: string): void => {
  if (recording.excluded.has(input)) return
  if (!input.isWellFormed()) {
    captureFault(recording, 'inspect non-Unicode path', '@overeng/genie/src/runtime/node/input-observations.ts')
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
      if (entry.isSymbolicLink()) {
        const bytes = fs.readlinkSync(prefix, { encoding: 'buffer' })
        const target = bytes.toString('utf8')
        if (!Buffer.from(target).equals(bytes)) throw new Error('Non-Unicode symlink target')
        retainObservation(recording, evidence.symlinks, prefix, { path: prefix, by: [], state: 'present', target })
      } else if (evidence.symlinks.has(prefix)) addReason(recording, { code: 'unstable-observation', operation: 'resolve symlink', detail: `Previously traversed symlink was replaced: ${prefix}`, source: { module: '@overeng/genie/src/runtime/node/input-observations.ts', line: null }, generators: [], evidence: 'observed' })
    }
    const stat = fs.statSync(input, { bigint: true })
    if ((evidence.files.get(input)?.state === 'present' && !stat.isFile()) || (evidence.directories.get(input)?.state === 'present' && !stat.isDirectory())) addReason(recording, { code: 'unstable-observation', operation: 'input type', detail: `Input changed its filesystem type: ${input}`, source: { module: '@overeng/genie/src/runtime/node/input-observations.ts', line: null }, generators: [], evidence: 'observed' })
    if (stat.isFile()) {
      const bytes = fs.readFileSync(input)
      const after = fs.statSync(input, { bigint: true })
      if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => Reflect.get(stat, key) !== Reflect.get(after, key))) addReason(recording, { code: 'unstable-observation', operation: 'readFile', detail: `File changed while consumed: ${input}`, source: { module: '@overeng/genie/src/runtime/node/input-observations.ts', line: null }, generators: [], evidence: 'observed' })
      retainObservation(recording, evidence.files, input, { path: input, by: [], state: 'present', digest: digestBytes(bytes), byteLength: bytes.byteLength })
    } else if (stat.isDirectory()) {
      // Read raw names separately from types: Bun ignores withFileTypes when encoding is buffer.
      // lstat preserves symlink identity, while the byte round-trip still rejects invalid UTF-8.
      const entries = fs.readdirSync(input, { encoding: 'buffer' }).map((bytes) => {
        const name = bytes.toString('utf8')
        if (Buffer.from(name).equals(bytes) === false || name.isWellFormed() === false) throw new Error('Non-Unicode directory name')
        return { name, type: entryType(fs.lstatSync(path.join(input, name))) }
      }).sort((left, right) => compareUtf8(left.name, right.name))
      retainObservation(recording, evidence.directories, input, { path: input, by: [], state: 'present', entries, digest: directoryDigest(entries) })
    } else {
      retainObservation(recording, evidence.stats, canonicalJson([input, true]), { path: input, followSymlinks: true, by: [], state: 'present', type: entryType(stat), values: statValues(stat) })
    }
  } catch (cause) {
    const missing = missingObservation(cause)
    if (missing === undefined) captureFault(recording, `inspect input: ${input}`, '@overeng/genie/src/runtime/node/input-observations.ts')
    else {
      retainObservation(recording, evidence.files, input, { path: input, by: [], ...missing })
      retainObservation(recording, evidence.directories, input, { path: input, by: [], ...missing })
    }
  }
}
