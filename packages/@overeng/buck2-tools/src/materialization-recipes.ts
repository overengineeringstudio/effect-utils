/* eslint-disable no-await-in-loop -- Ordered filesystem publication and bounded streaming hashes. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, fstatSync, lstatSync, realpathSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'

import {
  acquireExistingEditorViewLeaseUnderFence,
  ensureEditorViewLeaseControl,
  probeEditorViewLease,
} from './editor-view-leases.ts'
import { shareSnapshotFiles, withEditorViewContentStoreLock } from './editor-view-sharing.ts'
import {
  initializeMaterializationMetadata,
  lockMaterialization,
  syncMaterializationDirectory,
} from './materialization-metadata.ts'

const fail = (message: string): never => {
  throw new Error(`Buck recipe sharing: ${message}`)
}
const hash = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const compare = ({ left, right }: { left: string; right: string }): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right))
const absent = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'
/** Ordered, versioned extraction identity shared with the native replay reader. */
export type MaterializationRecipe = readonly [
  'effect-utils/buck-materialization-recipe/v1',
  string,
  string,
  string,
  readonly string[],
]
type Entry =
  | { path: string; file: { sha256: string; size: number; mode: '0444' | '0555' } }
  | { path: string; directory: true }
  | { path: string; symlink: string }
type Manifest = {
  schema: 'effect-utils/buck-materialization-tree/v1'
  recipe: MaterializationRecipe
  entries: Entry[]
}
type Tuple = readonly [string, number, string, string, string, string, string]
type Proof = readonly [
  'effect-utils/buck-materialization-recipe-proof/v1',
  Tuple,
  readonly (readonly [string, Tuple])[],
]
// eslint-disable-next-line no-control-regex -- Reject control bytes at the manifest trust boundary.
const unsafeLinkTarget = (target: string): boolean => /[\\\x00-\x1f\x7f]/.test(target)
const validPath = (path: string): boolean =>
  path.length > 0 &&
  Buffer.from(path).toString('utf8') === path &&
  path
    .split('/')
    .every(
      (part) => part !== '' && part !== '.' && part !== '..' && unsafeLinkTarget(part) === false,
    )
/** Decode the exact native recipe array, rejecting malformed or unsafe inputs. */
export const parseMaterializationRecipe = (value: unknown): MaterializationRecipe => {
  if (
    Array.isArray(value) === false ||
    value.length !== 5 ||
    value[0] !== 'effect-utils/buck-materialization-recipe/v1' ||
    digest(value[1]) === false ||
    digest(value[2]) === false ||
    typeof value[3] !== 'string' ||
    (value[3] !== '' && validPath(value[3]) === false) ||
    Array.isArray(value[4]) === false ||
    value[4].every(digest) === false
  )
    return fail('invalid recipe')
  return [value[0], value[1], value[2], value[3], value[4]]
}
/** SHA256 of the compact UTF8 recipe array, including ordered patches. */
export const materializationRecipeKey = (recipe: MaterializationRecipe): string =>
  hash(JSON.stringify(parseMaterializationRecipe(recipe)))
const identity = (status: BigIntStats): string =>
  [status.size, status.dev, status.ino, status.mode, status.uid, status.ctimeNs].join(':')
const tuple = ({ sha256, status }: { sha256: string; status: BigIntStats }): Tuple => [
  sha256,
  Number(status.size),
  String(status.dev),
  String(status.ino),
  String(status.mode),
  String(status.uid),
  String(status.ctimeNs),
]
const ownedDirectory = async (path: string): Promise<void> => {
  const status = await lstat(path, { bigint: true })
  if (
    status.isDirectory() === false ||
    status.uid !== BigInt(process.getuid!()) ||
    (status.mode & 0o077n) !== 0n ||
    realpathSync(path) !== path
  )
    fail(`unsafe directory: ${path}`)
}
const readStable = async ({
  path,
  mode,
  singleLink,
  expected,
  bounded = false,
  durable = false,
}: {
  path: string
  mode: number
  singleLink: boolean
  expected?: string
  bounded?: boolean
  durable?: boolean
}): Promise<{ text?: string; tuple: Tuple }> => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (
      before.isFile() === false ||
      before.uid !== BigInt(process.getuid!()) ||
      (before.mode & 0o7777n) !== BigInt(mode) ||
      (singleLink === true && before.nlink !== 1n) ||
      Number.isSafeInteger(Number(before.size)) === false ||
      (bounded === true && before.size > 64n * 1024n * 1024n)
    )
      fail(`unsafe payload: ${path}`)
    const sha = createHash('sha256')
    const chunks: Buffer[] = []
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      sha.update(chunk)
      if (bounded === true) chunks.push(Buffer.from(chunk))
    }
    const actual = sha.digest('hex')
    if (expected !== undefined && actual !== expected) fail(`content digest mismatch: ${path}`)
    if (durable === true) await file.sync()
    if (
      identity(before) !== identity(await file.stat({ bigint: true })) ||
      identity(before) !== identity(await lstat(path, { bigint: true }))
    )
      fail(`payload changed while hashing: ${path}`)
    return {
      ...(bounded === true ? { text: Buffer.concat(chunks).toString('utf8') } : {}),
      tuple: tuple({ sha256: actual, status: before }),
    }
  } finally {
    await file.close()
  }
}
const writeDurable = async ({
  path,
  text,
  mode,
}: {
  path: string
  text: string
  mode: number
}): Promise<void> => {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await file.writeFile(text)
    await file.chmod(mode)
    await file.sync()
  } finally {
    await file.close()
  }
}
const validateEntries = (entries: Entry[]): void => {
  if (entries.length === 0) fail('empty tree')
  const seen = new Map<string, Entry>()
  let previous: string | undefined
  for (const entry of entries) {
    if (
      validPath(entry.path) === false ||
      (previous !== undefined && compare({ left: previous, right: entry.path }) >= 0)
    )
      fail('noncanonical manifest paths')
    previous = entry.path
    const parent = posix.dirname(entry.path)
    const parentEntry = seen.get(parent)
    if (parent !== '.' && (parentEntry === undefined || 'directory' in parentEntry === false))
      fail('missing directory or symlink traversal')
    seen.set(entry.path, entry)
  }
  // Expand links before interpreting '..': lexical normalization alone can
  // incorrectly authorize a path that escapes through an intermediate link.
  for (const entry of entries)
    if ('symlink' in entry) {
      const resolved: string[] = []
      const pending = entry.path.split('/')
      let expansions = 0
      while (pending.length > 0) {
        const component = pending.shift()!
        if (component === '' || component === '.') continue
        if (component === '..') {
          if (resolved.length === 0) fail('escaping symlink')
          resolved.pop()
          continue
        }
        const path = [...resolved, component].join('/')
        const item = seen.get(path) ?? fail('dangling internal symlink')
        if ('symlink' in item) {
          if (++expansions > 40) fail('symlink cycle or excessive traversal')
          const target = item.symlink
          if (
            target === '' ||
            target.startsWith('/') === true ||
            unsafeLinkTarget(target) === true ||
            Buffer.from(target).toString('utf8') !== target
          )
            fail('unsafe symlink')
          pending.unshift(...target.split('/'))
        } else {
          if (pending.length > 0 && 'directory' in item === false)
            fail('symlink traverses regular file')
          resolved.push(component)
        }
      }
    }
}
const parseManifest = ({
  text,
  recipe,
}: {
  text: string
  recipe: MaterializationRecipe
}): Manifest => {
  const raw: unknown = JSON.parse(text)
  if (
    typeof raw !== 'object' ||
    raw === null ||
    'schema' in raw === false ||
    raw.schema !== 'effect-utils/buck-materialization-tree/v1' ||
    'recipe' in raw === false ||
    JSON.stringify(raw.recipe) !== JSON.stringify(recipe) ||
    'entries' in raw === false ||
    Array.isArray(raw.entries) === false
  )
    return fail('invalid manifest')
  const entries: Entry[] = raw.entries.map((entry: unknown) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      'path' in entry === false ||
      typeof entry.path !== 'string'
    )
      return fail('invalid manifest entry')
    if (
      'directory' in entry &&
      entry.directory === true &&
      JSON.stringify(entry) === JSON.stringify({ path: entry.path, directory: true })
    )
      return { path: entry.path, directory: true }
    if (
      'symlink' in entry &&
      typeof entry.symlink === 'string' &&
      JSON.stringify(entry) === JSON.stringify({ path: entry.path, symlink: entry.symlink })
    )
      return { path: entry.path, symlink: entry.symlink }
    if (
      'file' in entry &&
      typeof entry.file === 'object' &&
      entry.file !== null &&
      'sha256' in entry.file &&
      digest(entry.file.sha256) === true &&
      'size' in entry.file &&
      typeof entry.file.size === 'number' &&
      Number.isSafeInteger(entry.file.size) === true &&
      entry.file.size >= 0 &&
      'mode' in entry.file &&
      (entry.file.mode === '0444' || entry.file.mode === '0555')
    ) {
      const result: Entry = {
        path: entry.path,
        file: { sha256: entry.file.sha256, size: entry.file.size, mode: entry.file.mode },
      }
      if (JSON.stringify(result) === JSON.stringify(entry)) return result
    }
    return fail('invalid manifest entry')
  })
  validateEntries(entries)
  const manifest: Manifest = {
    schema: 'effect-utils/buck-materialization-tree/v1',
    recipe,
    entries,
  }
  if (JSON.stringify(manifest) !== text) fail('noncanonical manifest')
  return manifest
}
const blobs = (
  manifest: Manifest,
): Map<string, { sha256: string; size: number; mode: '0444' | '0555' }> => {
  const result = new Map<string, { sha256: string; size: number; mode: '0444' | '0555' }>()
  for (const entry of manifest.entries)
    if ('file' in entry) result.set(`${entry.file.sha256}-${entry.file.mode}`, entry.file)
  return new Map([...result].toSorted(([left], [right]) => compare({ left: left, right: right })))
}
const proofFor = async ({
  directory,
  contentStore,
  manifest,
  establishedDigest,
  durable = false,
}: {
  directory: string
  contentStore: string
  manifest: Manifest
  establishedDigest: string
  durable?: boolean
}): Promise<Proof> => {
  const manifestRead = await readStable({
    path: join(directory, 'manifest.json'),
    mode: 0o444,
    singleLink: true,
    expected: establishedDigest,
    bounded: true,
  })
  const pins = blobs(manifest)
  if (
    (await readdir(join(directory, 'pins')))
      .toSorted((left, right) => compare({ left, right }))
      .join('\n') !== [...pins.keys()].join('\n')
  )
    fail('noncanonical pins')
  const tuples: (readonly [string, Tuple])[] = []
  for (const [key, blob] of pins) {
    const pinned = await readStable({
      path: join(directory, 'pins', key),
      mode: Number.parseInt(blob.mode, 8),
      singleLink: false,
      expected: blob.sha256,
      bounded: false,
      durable: durable,
    })
    if (pinned.tuple[1] !== blob.size) fail('pin size mismatch')
    const canonical = await lstat(join(contentStore, blob.sha256.slice(0, 2), key), {
      bigint: true,
    })
    if (identity(canonical) !== pinned.tuple.slice(1).join(':'))
      fail('pin is not canonical CAS inode')
    tuples.push([key, pinned.tuple])
  }
  return ['effect-utils/buck-materialization-recipe-proof/v1', manifestRead.tuple, tuples]
}
const publishProof = async ({
  directory,
  proof,
}: {
  directory: string
  proof: Proof
}): Promise<void> => {
  const pending = join(directory, 'verification.pending')
  try {
    await readStable({
      path: pending,
      mode: 0o600,
      singleLink: true,
      expected: undefined,
      bounded: true,
    })
    await unlink(pending)
  } catch (error) {
    if (absent(error) === false) throw error
  }
  await writeDurable({ path: pending, text: `${JSON.stringify(proof)}\n`, mode: 0o600 })
  await rename(pending, join(directory, 'verification.json'))
  await syncMaterializationDirectory(directory)
}
const establishedManifest = async ({
  directory,
  recipe,
}: {
  directory: string
  recipe: MaterializationRecipe
}): Promise<{ manifest: Manifest; sha256: string }> => {
  const proofRead = await readStable({
    path: join(directory, 'verification.json'),
    mode: 0o600,
    singleLink: true,
    expected: undefined,
    bounded: true,
  })
  const raw: unknown = JSON.parse(proofRead.text!)
  const validTuple = (value: unknown): value is Tuple =>
    Array.isArray(value) &&
    value.length === 7 &&
    digest(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isSafeInteger(value[1]) &&
    value[1] >= 0 &&
    value.slice(2).every((item) => typeof item === 'string' && /^[0-9]+$/.test(item))
  if (
    Array.isArray(raw) === false ||
    raw.length !== 3 ||
    raw[0] !== 'effect-utils/buck-materialization-recipe-proof/v1' ||
    validTuple(raw[1]) === false ||
    Array.isArray(raw[2]) === false ||
    raw[2].every(
      (item) =>
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === 'string' &&
        /^[a-f0-9]{64}-(0444|0555)$/.test(item[0]) &&
        validTuple(item[1]),
    ) === false ||
    `${JSON.stringify(raw)}\n` !== proofRead.text
  )
    return fail('invalid verification proof')
  const manifestRead = await readStable({
    path: join(directory, 'manifest.json'),
    mode: 0o444,
    singleLink: true,
    expected: raw[1][0],
    bounded: true,
  })
  const manifest = parseManifest({ text: manifestRead.text!, recipe: recipe })
  if (JSON.stringify(raw[2].map((item) => item[0])) !== JSON.stringify([...blobs(manifest).keys()]))
    fail('proof pin inventory mismatch')
  if (
    raw[1][1] !== manifestRead.tuple[1] ||
    raw[1][4] !== String(0o100444) ||
    raw[1][5] !== String(process.getuid!())
  )
    fail('invalid proof manifest identity')
  const expectedBlobs = blobs(manifest)
  for (const item of raw[2]) {
    const expected = expectedBlobs.get(item[0]) ?? fail('unexpected proof blob')
    if (
      item[1][0] !== expected.sha256 ||
      item[1][1] !== expected.size ||
      item[1][4] !== String(0o100000 | Number.parseInt(expected.mode, 8)) ||
      item[1][5] !== String(process.getuid!())
    )
      fail('invalid proof blob identity')
  }
  return { manifest, sha256: raw[1][0] }
}
/** Create validated metadata and a durable recipe control, without payload writes. */
export const prepareMaterializationRecipe = async ({
  contentStore,
  recipe,
}: {
  contentStore: string
  recipe: MaterializationRecipe
}): Promise<void> => {
  const metadata = initializeMaterializationMetadata(contentStore)
  const lock = await lockMaterialization({
    metadata,
    digest: materializationRecipeKey(recipe),
    kind: 'recipe',
  })
  if (lock === undefined) fail('recipe control unavailable')
  await lock!.sync()
  await lock!.close()
  await syncMaterializationDirectory(join(metadata, '.recipes'))
  await syncMaterializationDirectory(metadata)
}
/** Validate the inherited exclusion descriptor without acquiring or changing its lock. */
export const validateInheritedRecipeLock = ({
  contentStore,
  recipe,
  fd,
}: {
  contentStore: string
  recipe: MaterializationRecipe
  fd: number
}): void => {
  const path = join(
    `${contentStore}.buck-materialization-v1`,
    '.recipes',
    `${materializationRecipeKey(recipe)}.lock`,
  )
  const held = fstatSync(fd, { bigint: true })
  const named = lstatSync(path, { bigint: true })
  if (
    held.isFile() === false ||
    held.uid !== BigInt(process.getuid!()) ||
    held.nlink !== 1n ||
    (held.mode & 0o7777n) !== 0o600n ||
    held.dev !== named.dev ||
    held.ino !== named.ino ||
    named.nlink !== 1n
  )
    fail('stdin is not inherited recipe exclusion')
}
/** Fully rehash the established generation and atomically refresh its ctime proof. */
export const verifyMaterializationRecipe = async ({
  contentStore,
  recipe,
  lockFd,
}: {
  contentStore: string
  recipe: MaterializationRecipe
  lockFd: number
}): Promise<void> => {
  validateInheritedRecipeLock({ contentStore, recipe, fd: lockFd })
  const metadata = `${contentStore}.buck-materialization-v1`
  const generation = `recipe-${materializationRecipeKey(recipe)}`
  const directory = join(metadata, '.store', generation)
  await ownedDirectory(directory)
  // Read-only control validation: never repair a published generation.
  const lease = acquireExistingEditorViewLeaseUnderFence({
    editorRoot: metadata,
    snapshot: generation,
  })
  try {
    const established = await establishedManifest({ directory: directory, recipe: recipe })
    await publishProof({
      directory: directory,
      proof: await proofFor({
        directory: directory,
        contentStore: contentStore,
        manifest: established.manifest,
        establishedDigest: established.sha256,
      }),
    })
  } finally {
    lease.release()
  }
}
/** Admit a native-private extraction through the existing CAS and durably publish it. */
export const publishMaterializationRecipe = async ({
  contentStore,
  recipe,
  tree,
  lockFd,
}: {
  contentStore: string
  recipe: MaterializationRecipe
  tree: string
  lockFd: number
}): Promise<void> => {
  validateInheritedRecipeLock({ contentStore, recipe, fd: lockFd })
  const metadata = `${contentStore}.buck-materialization-v1`
  const key = materializationRecipeKey(recipe)
  const generation = `recipe-${key}`
  const destination = join(metadata, '.store', generation)
  try {
    await lstat(destination)
    fail('generation already exists')
  } catch (error) {
    if (absent(error) === false) throw error
  }
  // Recipe exclusion proves abandoned unpublished stages have no live writer.
  for (const name of await readdir(join(metadata, '.staging'))) {
    if (name.startsWith(`${generation}-`) === false) continue
    if (new RegExp(`^${generation}-[a-f0-9-]{36}$`).test(name) === false)
      fail('unknown recipe staging entry')
    await removeUnpublishedStage({
      directory: join(metadata, '.staging', name),
      contentStore: contentStore,
    })
  }
  const root = resolve(tree)
  const rootStatus = await lstat(root, { bigint: true })
  if (
    rootStatus.isDirectory() === false ||
    rootStatus.uid !== BigInt(process.getuid!()) ||
    (rootStatus.mode & 0o022n) !== 0n ||
    realpathSync(root) !== root
  )
    fail('unsafe private tree')
  const entries: Entry[] = []
  const files: string[] = []
  const walk = async ({
    directory,
    prefix,
  }: {
    directory: string
    prefix: string
  }): Promise<void> => {
    for (const name of (await readdir(directory)).toSorted((left, right) =>
      compare({ left, right }),
    )) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (validPath(path) === false) fail('unsafe private tree path')
      const absolute = join(root, path)
      const status = await lstat(absolute, { bigint: true })
      if (status.uid !== BigInt(process.getuid!())) fail('unowned private tree entry')
      if (status.isDirectory() === true) {
        entries.push({ path, directory: true })
        await walk({ directory: absolute, prefix: path })
      } else if (status.isSymbolicLink() === true)
        entries.push({ path, symlink: await readlink(absolute) })
      else if (status.isFile() === true && status.nlink === 1n) files.push(absolute)
      else fail('private tree contains unsupported or shared file')
    }
  }
  await walk({ directory: root, prefix: '' })
  const shared = new Map<string, { digest: string; mode: number }>()
  await shareSnapshotFiles({
    candidate: root,
    contentStore,
    candidateFiles: files,
    onSharedFile: (file) => {
      shared.set(file.path, file)
    },
  })
  for (const file of files) {
    const admitted = shared.get(file) ?? fail('file was not admitted')
    entries.push({
      path: file.slice(root.length + 1),
      file: {
        sha256: admitted.digest,
        size: Number((await lstat(file)).size),
        mode: admitted.mode === 0o444 ? '0444' : '0555',
      },
    })
  }
  const sortedEntries = entries.toSorted((left, right) =>
    compare({ left: left.path, right: right.path }),
  )
  validateEntries(sortedEntries)
  const manifest: Manifest = {
    schema: 'effect-utils/buck-materialization-tree/v1',
    recipe,
    entries: sortedEntries,
  }
  const text = JSON.stringify(manifest)
  const stage = join(metadata, '.staging', `${generation}-${randomUUID()}`)
  await mkdir(stage, { mode: 0o700 })
  await mkdir(join(stage, 'pins'), { mode: 0o700 })
  // Private tree retains CAS lifetime links while the single pin set is installed.
  await withEditorViewContentStoreLock({
    contentStore,
    run: async () => {
      for (const [blobKey, blob] of blobs(manifest))
        await link(
          join(contentStore, blob.sha256.slice(0, 2), blobKey),
          join(stage, 'pins', blobKey),
        )
    },
  })
  for (const blob of blobs(manifest).values())
    await syncMaterializationDirectory(join(contentStore, blob.sha256.slice(0, 2)))
  await syncMaterializationDirectory(join(stage, 'pins'))
  await writeDurable({ path: join(stage, 'manifest.json'), text: text, mode: 0o444 })
  await publishProof({
    directory: stage,
    proof: await proofFor({
      directory: stage,
      contentStore: contentStore,
      manifest: manifest,
      establishedDigest: hash(text),
      durable: true,
    }),
  })
  await withEditorViewContentStoreLock({
    contentStore,
    run: async () => {
      ensureEditorViewLeaseControl({
        editorRoot: metadata,
        snapshot: generation,
        generationDirectory: stage,
      })
      await syncMaterializationDirectory(stage)
      await rename(stage, destination)
      await syncMaterializationDirectory(join(metadata, '.store'))
      await syncMaterializationDirectory(join(metadata, '.staging'))
    },
  })
}

const removeUnpublishedStage = async ({
  directory,
  contentStore,
}: {
  directory: string
  contentStore: string
}): Promise<void> => {
  await ownedDirectory(directory)
  const names = await readdir(directory)
  if (
    names.some(
      (name) =>
        ['pins', 'manifest.json', 'verification.json', 'verification.pending'].includes(name) ===
        false,
    ) === true
  )
    fail('unknown staged recipe entry')
  const pins = names.includes('pins') === true ? await readdir(join(directory, 'pins')) : []
  if (names.includes('pins') === true) await ownedDirectory(join(directory, 'pins'))
  if (pins.some((pin) => /^[a-f0-9]{64}-(0444|0555)$/.test(pin) === false) === true)
    fail('unknown staged recipe pin')
  await withEditorViewContentStoreLock({
    contentStore,
    run: async () => {
      for (const pin of pins) {
        const path = join(directory, 'pins', pin)
        const status = await lstat(path, { bigint: true })
        if (
          status.isFile() === false ||
          status.uid !== BigInt(process.getuid!()) ||
          [0o444n, 0o555n].includes(status.mode & 0o7777n) === false
        )
          fail('unsafe staged recipe pin')
        await unlink(path)
      }
      if (names.includes('pins') === true) await rmdir(join(directory, 'pins'))
      for (const name of names)
        if (name !== 'pins') {
          const path = join(directory, name)
          const status = await lstat(path, { bigint: true })
          if (
            status.isFile() === false ||
            status.uid !== BigInt(process.getuid!()) ||
            status.nlink !== 1n
          )
            fail('unsafe staged recipe metadata')
          await unlink(path)
        }
      await rmdir(directory)
    },
  })
}

/** Recipe exclusion is retained by caller; no payload hashing occurs under C. */
export const retireMaterializationRecipe = async ({
  contentStore,
  metadata,
  generation,
  garbageName,
}: {
  contentStore: string
  metadata: string
  generation: string
  garbageName?: string
}): Promise<void> => {
  const recipeKey =
    /^recipe-([a-f0-9]{64})$/.exec(generation)?.[1] ?? fail('invalid recipe generation')
  const directory = join(
    metadata,
    garbageName === undefined ? '.store' : '.garbage',
    garbageName ?? generation,
  )
  await ownedDirectory(directory)
  const names = await readdir(directory)
  if (
    names.some(
      (name) =>
        ['pins', 'manifest.json', 'verification.json', 'verification.pending'].includes(name) ===
        false,
    ) === true
  )
    fail('unknown recipe generation entry')
  if (
    garbageName === undefined &&
    ['pins', 'manifest.json', 'verification.json'].every((name) => names.includes(name)) === false
  )
    fail('incomplete published recipe')
  let manifestPins: Map<string, { sha256: string; size: number; mode: '0444' | '0555' }> | undefined
  if (names.includes('manifest.json') === true) {
    const read = await readStable({
      path: join(directory, 'manifest.json'),
      mode: 0o444,
      singleLink: true,
      expected: undefined,
      bounded: true,
    })
    const raw: unknown = JSON.parse(read.text!)
    if (typeof raw !== 'object' || raw === null || 'recipe' in raw === false)
      fail('unknown retired recipe format')
    const recipe = parseMaterializationRecipe(raw.recipe)
    if (materializationRecipeKey(recipe) !== recipeKey) fail('retired recipe key mismatch')
    const manifest = parseManifest({ text: read.text!, recipe: recipe })
    if (names.includes('verification.json') === true)
      await establishedManifest({ directory: directory, recipe: recipe })
    manifestPins = blobs(manifest)
  } else if (names.some((name) => name !== 'pins') === true)
    fail('incomplete retired recipe metadata')
  // A garbage directory may already have lost some pins. Validate names, never
  // repair the control or assume a missing control means readers are absent.
  const pinDirectory = join(directory, 'pins')
  let pins: string[] = []
  try {
    await ownedDirectory(pinDirectory)
    pins = await readdir(pinDirectory)
  } catch (error) {
    if (absent(error) === false) throw error
  }
  if (pins.some((pin) => /^[a-f0-9]{64}-(0444|0555)$/.test(pin) === false) === true)
    fail('unknown recipe pin')
  const allowedPins = manifestPins
  if (
    allowedPins !== undefined &&
    (pins.some((pin) => allowedPins.has(pin) === false) === true ||
      (garbageName === undefined && pins.length !== allowedPins.size))
  )
    fail('retired recipe pin inventory mismatch')
  await withEditorViewContentStoreLock({
    contentStore,
    run: async () => {
      const lease = probeEditorViewLease({
        editorRoot: metadata,
        snapshot: `recipe-${recipeKey}`,
        generationDirectory: directory,
      })
      try {
        if (lease.state === 'held') return
        if (lease.state !== 'clear')
          fail(`unsafe recipe generation control: ${lease.reasons.join('; ')}`)
        const garbage =
          garbageName === undefined
            ? join(metadata, '.garbage', `${generation}-${randomUUID()}`)
            : directory
        if (garbageName === undefined) await rename(directory, garbage)
        for (const pin of pins) {
          const path = join(garbage, 'pins', pin)
          const status = await lstat(path, { bigint: true })
          if (
            status.isFile() === false ||
            status.uid !== BigInt(process.getuid!()) ||
            [0o444n, 0o555n].includes(status.mode & 0o7777n) === false
          )
            fail('unsafe retired recipe pin')
          await unlink(path)
        }
        if (names.includes('pins') === true) await rmdir(join(garbage, 'pins'))
        for (const name of [
          ...names.filter((entryName) => entryName !== 'pins' && entryName !== 'manifest.json'),
          ...names.filter((entryName) => entryName === 'manifest.json'),
        ]) {
          const path = join(garbage, name)
          const status = await lstat(path, { bigint: true })
          if (
            status.isFile() === false ||
            status.uid !== BigInt(process.getuid!()) ||
            status.nlink !== 1n
          )
            fail('unsafe retired recipe metadata')
          await unlink(path)
        }
        await rmdir(garbage)
        await syncMaterializationDirectory(join(metadata, '.garbage'))
        await syncMaterializationDirectory(join(metadata, '.store'))
      } finally {
        lease.release()
      }
    },
  })
}
