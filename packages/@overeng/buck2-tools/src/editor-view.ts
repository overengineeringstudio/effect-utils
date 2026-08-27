#!/usr/bin/env -S bun
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'

/** Versioned identity of the persisted scoped editor-view record. */
export const editorViewSchema = 'effect-utils/editor-view/v1' as const
const treeDigestSchema = 'effect-utils/tree-digest/v1' as const
const fingerprintPattern = /^[0-9a-f]{64}$/
const currentName = 'tui-core'
const scopedPackage = 'packages/@overeng/tui-core'
const scopedCell = 'tui-core'
const scopedTarget = '//packages/@overeng/tui-core:editor_inputs'
const firstHopTarget = '../../.editor-view/tui-core/node_modules'
const lockSchema = 'effect-utils/editor-view-lock/v1' as const
const editorViewRecordFields = [
  'cell',
  'editorInputsFingerprint',
  'nodeModulesTreeDigest',
  'package',
  'schema',
  'snapshot',
  'target',
] as const
const lockRecordFields = ['pid', 'schema', 'token'] as const

type JsonRecord = { [key: string]: unknown }

/** Persisted identity and content evidence for one immutable editor snapshot. */
export type EditorViewRecord = {
  readonly schema: typeof editorViewSchema
  readonly package: string
  readonly cell: string
  readonly target: string
  readonly editorInputsFingerprint: string
  readonly snapshot: string
  readonly nodeModulesTreeDigest: string
}

/** Explicit paths, identity, and immutable publication tools for the scoped tui-core view. */
export type EditorViewOptions = {
  readonly repoRoot: string
  readonly package: string
  readonly cell: string
  readonly target: string
  readonly editorInputs: string
  readonly nodeModules: string
  readonly cp: string
  readonly mv: string
}

type ViewPaths = {
  readonly repoRoot: string
  readonly packageDir: string
  readonly editorRoot: string
  readonly storeDir: string
  readonly legacyDir: string
  readonly current: string
  readonly firstHop: string
}

type CheckContext = {
  recordedFingerprint: string
  readonly currentFingerprint: string
}

const fail = (message: string): never => {
  throw new Error(`editor view: ${message}`)
}

const failCheck = ({ message, context }: { message: string; context: CheckContext }): never => {
  return fail(
    `${message}; recorded fingerprint=${context.recordedFingerprint}; current fingerprint=${context.currentFingerprint}`,
  )
}

const compareBytes = ({ left, right }: { left: string; right: string }): number =>
  Buffer.from(left).compare(Buffer.from(right))

const u64 = (value: bigint): Buffer => {
  const framed = Buffer.allocUnsafe(8)
  framed.writeBigUInt64BE(value)
  return framed
}

const frame = (value: string): readonly [Buffer, Buffer] => {
  const encoded = Buffer.from(value)
  return [u64(BigInt(encoded.byteLength)), encoded]
}

const pathExists = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isNodeErrorCode({ error, code: 'ENOENT' }) === true) return false
    throw error
  }
}

const isNodeErrorCode = ({ error, code }: { error: unknown; code: string }): boolean =>
  error instanceof Error && 'code' in error && error.code === code

const requireDirectory = ({ path, field }: { path: string; field: string }): void => {
  let status
  try {
    status = lstatSync(path)
  } catch (error) {
    return fail(
      `${field} is missing: ${path} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (status.isSymbolicLink() === true || status.isDirectory() === false)
    fail(`${field} must be a real directory: ${path}`)
}

const ensureRealDirectory = ({ path, field }: { path: string; field: string }): void => {
  if (existsSync(path) === false) mkdirSync(path)
  requireDirectory({ path, field })
}

const streamFileIntoHash = async ({
  path,
  hash,
}: {
  path: string
  hash: ReturnType<typeof createHash>
}) => {
  for await (const chunk of createReadStream(path)) hash.update(chunk)
}

/**
 * Hash a tree with byte-sorted portable paths and length-framed entry data.
 * Directory, regular-file, and symlink kinds are distinct; special files fail closed.
 */
export const canonicalTreeFingerprint = async (tree: string): Promise<string> => {
  const absoluteTree = resolve(tree)
  requireDirectory({ path: absoluteTree, field: 'tree input' })
  const hash = createHash('sha256')
  hash.update(treeDigestSchema)
  hash.update(Buffer.from([0]))

  const visit = async (relativePath: string): Promise<void> => {
    const absolutePath = join(absoluteTree, relativePath)
    const before = lstatSync(absolutePath, { bigint: true })
    const [pathLength, pathBytes] = frame(relativePath)
    if (before.isDirectory() === true) {
      hash.update(Buffer.from('D'))
      hash.update(pathLength)
      hash.update(pathBytes)
      const names = readdirSync(absolutePath).toSorted((left, right) =>
        compareBytes({ left, right }),
      )
      await visitNames({ names, parent: relativePath })
      const after = lstatSync(absolutePath, { bigint: true })
      if (
        after.isDirectory() === false ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      )
        fail(`tree changed while hashing: ${absolutePath}`)
      return
    }
    if (before.isSymbolicLink() === true) {
      const target = readlinkSync(absolutePath)
      const [targetLength, targetBytes] = frame(target)
      hash.update(Buffer.from('L'))
      hash.update(pathLength)
      hash.update(pathBytes)
      hash.update(targetLength)
      hash.update(targetBytes)
      const after = lstatSync(absolutePath, { bigint: true })
      if (
        after.isSymbolicLink() === false ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        readlinkSync(absolutePath) !== target
      )
        fail(`tree changed while hashing: ${absolutePath}`)
      return
    }
    if (before.isFile() === false) fail(`tree contains unsupported special file: ${absolutePath}`)
    hash.update(Buffer.from('F'))
    hash.update(pathLength)
    hash.update(pathBytes)
    hash.update(u64(before.size))
    await streamFileIntoHash({ path: absolutePath, hash })
    const after = lstatSync(absolutePath, { bigint: true })
    if (
      after.isFile() === false ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      fail(`tree changed while hashing: ${absolutePath}`)
  }

  const visitNames = async ({
    names,
    parent,
    index = 0,
  }: {
    names: readonly string[]
    parent: string
    index?: number
  }): Promise<void> => {
    const name = names[index]
    if (name === undefined) return
    await visit(parent.length === 0 ? name : `${parent}/${name}`)
    await visitNames({ names, parent, index: index + 1 })
  }

  const rootBefore = lstatSync(absoluteTree, { bigint: true })
  const names = readdirSync(absoluteTree).toSorted((left, right) => compareBytes({ left, right }))
  await visitNames({ names, parent: '' })
  const rootAfter = lstatSync(absoluteTree, { bigint: true })
  if (
    rootAfter.isDirectory() === false ||
    rootAfter.dev !== rootBefore.dev ||
    rootAfter.ino !== rootBefore.ino ||
    rootAfter.mtimeNs !== rootBefore.mtimeNs ||
    rootAfter.ctimeNs !== rootBefore.ctimeNs
  )
    fail(`tree changed while hashing: ${absoluteTree}`)
  return hash.digest('hex')
}

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && Array.isArray(value) === false && typeof value === 'object'

const readRecord = (path: string): EditorViewRecord => {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return fail(`invalid record ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (isRecord(value) === false) return fail(`record must be a JSON object: ${path}`)
  const record = value
  if (
    JSON.stringify(Object.keys(record).toSorted((left, right) => compareBytes({ left, right }))) !==
    JSON.stringify(editorViewRecordFields)
  )
    return fail(`record has unknown or missing fields: ${path}`)
  const schema = record.schema
  const packageName = record.package
  const cell = record.cell
  const target = record.target
  const editorInputsFingerprint = record.editorInputsFingerprint
  const snapshot = record.snapshot
  const nodeModulesTreeDigest = record.nodeModulesTreeDigest
  if (
    schema !== editorViewSchema ||
    typeof packageName !== 'string' ||
    typeof cell !== 'string' ||
    typeof target !== 'string' ||
    typeof editorInputsFingerprint !== 'string' ||
    fingerprintPattern.test(editorInputsFingerprint) === false ||
    typeof snapshot !== 'string' ||
    typeof nodeModulesTreeDigest !== 'string' ||
    fingerprintPattern.test(nodeModulesTreeDigest) === false
  )
    return fail(`record does not conform to ${editorViewSchema}: ${path}`)
  return {
    schema,
    package: packageName,
    cell,
    target,
    editorInputsFingerprint,
    snapshot,
    nodeModulesTreeDigest,
  }
}

const requirePortablePackage = (value: string): string => {
  if (
    value.length === 0 ||
    isAbsolute(value) === true ||
    value.includes('\\') === true ||
    value
      .split('/')
      .some((component) => component === '' || component === '.' || component === '..') === true
  )
    fail(`package must be a normalized repository-relative path: ${value}`)
  return value
}

const isWithin = ({ root, candidate }: { root: string; candidate: string }): boolean => {
  const pathFromRoot = relative(root, candidate)
  return (
    pathFromRoot === '' ||
    (isAbsolute(pathFromRoot) === false &&
      pathFromRoot !== '..' &&
      pathFromRoot.startsWith('../') === false)
  )
}

const makePaths = (options: EditorViewOptions): ViewPaths => {
  if (options.package !== scopedPackage)
    fail(`package must be the scoped editor package ${scopedPackage}`)
  const repoRoot = realpathSync(options.repoRoot)
  requireDirectory({ path: repoRoot, field: 'repository root' })
  const packagePath = requirePortablePackage(options.package)
  const packageDir = resolve(repoRoot, packagePath)
  if (isWithin({ root: repoRoot, candidate: packageDir }) === false)
    fail(`package escapes repository root: ${packagePath}`)
  requireDirectory({ path: packageDir, field: 'package directory' })
  if (realpathSync(packageDir) !== packageDir)
    fail(`package path must not contain symbolic links: ${packageDir}`)
  const editorRoot = resolve(packageDir, '..', '..', '.editor-view')
  if (isWithin({ root: repoRoot, candidate: editorRoot }) === false)
    fail(`editor root escapes repository: ${editorRoot}`)
  return {
    repoRoot,
    packageDir,
    editorRoot,
    storeDir: join(editorRoot, '.store'),
    legacyDir: join(editorRoot, '.legacy'),
    current: join(editorRoot, currentName),
    firstHop: join(packageDir, 'node_modules'),
  }
}

const requireScopedRecordIdentity = (options: EditorViewOptions): void => {
  if (options.cell !== scopedCell) fail(`cell must be ${scopedCell}`)
  if (options.target !== scopedTarget) fail(`target must be the stable label ${scopedTarget}`)
}

const expectedRecord = ({
  options,
  fingerprint,
  nodeModulesTreeDigest,
}: {
  options: EditorViewOptions
  fingerprint: string
  nodeModulesTreeDigest: string
}): EditorViewRecord => ({
  schema: editorViewSchema,
  package: options.package,
  cell: options.cell,
  target: options.target,
  editorInputsFingerprint: fingerprint,
  snapshot: `.store/${currentName}-${fingerprint}`,
  nodeModulesTreeDigest,
})

const recordsEqual = ({
  left,
  right,
}: {
  left: EditorViewRecord
  right: EditorViewRecord
}): boolean => JSON.stringify(left) === JSON.stringify(right)

const writeRecord = ({ path, record }: { path: string; record: EditorViewRecord }): void => {
  writeFileSync(path, `${JSON.stringify(record, undefined, 2)}\n`, { flag: 'wx' })
}

const requireImmutableTool = ({ tool, label }: { tool: string; label: string }): void => {
  if (isAbsolute(tool) === false) fail(`${label} tool must be an immutable absolute path: ${tool}`)
  let immutableTool: string
  try {
    immutableTool = realpathSync(tool)
  } catch (error) {
    return fail(
      `${label} tool cannot be resolved: ${tool} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (immutableTool.startsWith('/nix/store/') === false)
    fail(`${label} tool must resolve into the immutable Nix store: ${immutableTool}`)
}

const runTool = ({
  tool,
  args,
  label,
}: {
  tool: string
  args: readonly string[]
  label: string
}): void => {
  requireImmutableTool({ tool, label })
  const result = spawnSync(tool, args, {
    cwd: '/',
    env: { PATH: '' },
    input: undefined,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0)
    fail(
      `${label} failed with exit ${result.status ?? 'unknown'}: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`,
    )
}

const assertHardlinkedTrees = ({
  source,
  snapshot,
}: {
  source: string
  snapshot: string
}): void => {
  const visit = (relativePath: string): void => {
    const sourcePath = join(source, relativePath)
    const snapshotPath = join(snapshot, relativePath)
    const sourceStatus = lstatSync(sourcePath, { bigint: true })
    const snapshotStatus = lstatSync(snapshotPath, { bigint: true })
    if (
      (sourceStatus.isDirectory() === false &&
        sourceStatus.isFile() === false &&
        sourceStatus.isSymbolicLink() === false) ||
      (snapshotStatus.isDirectory() === false &&
        snapshotStatus.isFile() === false &&
        snapshotStatus.isSymbolicLink() === false)
    )
      fail(`snapshot contains unsupported special file: ${relativePath}`)
    if (
      sourceStatus.isDirectory() !== snapshotStatus.isDirectory() ||
      sourceStatus.isFile() !== snapshotStatus.isFile() ||
      sourceStatus.isSymbolicLink() !== snapshotStatus.isSymbolicLink()
    )
      fail(`snapshot entry type mismatch: ${relativePath}`)
    if (
      sourceStatus.isFile() === true &&
      (sourceStatus.dev !== snapshotStatus.dev || sourceStatus.ino !== snapshotStatus.ino)
    )
      fail(`snapshot regular file is not a same-filesystem hardlink: ${relativePath}`)
    if (
      sourceStatus.isSymbolicLink() === true &&
      readlinkSync(sourcePath) !== readlinkSync(snapshotPath)
    )
      fail(`snapshot symlink target mismatch: ${relativePath}`)
    if (sourceStatus.isDirectory() === true) {
      const sourceNames = readdirSync(sourcePath).toSorted((left, right) =>
        compareBytes({ left, right }),
      )
      const snapshotNames = readdirSync(snapshotPath).toSorted((left, right) =>
        compareBytes({ left, right }),
      )
      if (JSON.stringify(sourceNames) !== JSON.stringify(snapshotNames))
        fail(`snapshot directory entries mismatch: ${relativePath || '.'}`)
      for (const name of sourceNames)
        visit(relativePath.length === 0 ? name : `${relativePath}/${name}`)
    }
  }
  const sourceNames = readdirSync(source).toSorted((left, right) => compareBytes({ left, right }))
  const snapshotNames = readdirSync(snapshot).toSorted((left, right) =>
    compareBytes({ left, right }),
  )
  if (JSON.stringify(sourceNames) !== JSON.stringify(snapshotNames))
    fail('snapshot root entries mismatch')
  for (const name of sourceNames) visit(name)
}

type LockOwner = {
  readonly schema: typeof lockSchema
  readonly token: string
  readonly pid: number
}

const readLockOwner = (path: string): LockOwner => {
  let owner: unknown
  try {
    owner = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return fail(
      `cannot read publication lock owner: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (
    isRecord(owner) === false ||
    JSON.stringify(Object.keys(owner).toSorted((left, right) => compareBytes({ left, right }))) !==
      JSON.stringify(lockRecordFields) ||
    owner.schema !== lockSchema ||
    typeof owner.token !== 'string' ||
    owner.token.length === 0 ||
    typeof owner.pid !== 'number' ||
    Number.isSafeInteger(owner.pid) === false ||
    owner.pid <= 0
  )
    return fail(`publication lock owner does not conform to ${lockSchema}: ${path}`)
  return { schema: lockSchema, token: owner.token, pid: owner.pid }
}

const acquireLock = ({
  editorRoot,
  recoveryCommand,
}: {
  editorRoot: string
  recoveryCommand: string
}): { readonly path: string; readonly token: string } => {
  const lockPath = join(editorRoot, '.publish.lock')
  const token = randomUUID()
  try {
    mkdirSync(lockPath)
  } catch (error) {
    if (isNodeErrorCode({ error, code: 'EEXIST' }) === false) throw error
    let owner = '<unreadable>'
    try {
      owner = readFileSync(join(lockPath, 'owner.json'), 'utf8').trim()
    } catch {}
    fail(
      `publication lock exists at ${lockPath}; owner=${owner}; recovery requires explicit: ${recoveryCommand} --token <owner-token>`,
    )
  }
  try {
    writeFileSync(
      join(lockPath, 'owner.json'),
      `${JSON.stringify({ schema: lockSchema, token, pid: process.pid })}\n`,
      { flag: 'wx' },
    )
  } catch (error) {
    rmSync(lockPath, { recursive: true, force: true })
    throw error
  }
  return { path: lockPath, token }
}

const releaseLock = ({ path, token }: { path: string; token: string }): void => {
  const owner = readLockOwner(join(path, 'owner.json'))
  if (owner.token !== token) fail(`publication lock ownership changed: ${path}`)
  rmSync(path, { recursive: true })
}

/** Remove the publication lock only when the caller presents its exact owner token. */
export const recoverEditorViewLock = ({
  options,
  token,
}: {
  options: EditorViewOptions
  token: string
}): void => {
  const paths = makePaths(options)
  ensureRealDirectory({ path: paths.editorRoot, field: 'editor root' })
  const lockPath = join(paths.editorRoot, '.publish.lock')
  const owner = readLockOwner(join(lockPath, 'owner.json'))
  if (owner.token !== token)
    fail(`publication lock token mismatch at ${lockPath}; lock was not removed`)
  const tokenDigest = createHash('sha256').update(token).digest('hex')
  const recoveredPath = join(paths.editorRoot, `.publish.lock.recovered-${tokenDigest}`)
  renameSync(lockPath, recoveredPath)
  rmSync(recoveredPath, { recursive: true })
}

const validateSnapshot = async ({
  snapshotDir,
  expected,
  admittedDigest,
}: {
  snapshotDir: string
  expected: EditorViewRecord
  admittedDigest: string
}): Promise<void> => {
  requireDirectory({ path: snapshotDir, field: 'snapshot' })
  const record = readRecord(join(snapshotDir, 'editor-view.json'))
  if (recordsEqual({ left: record, right: expected }) === false)
    fail(`existing snapshot record mismatch: ${snapshotDir}`)
  const snapshotNodeModules = join(snapshotDir, 'node_modules')
  requireDirectory({ path: snapshotNodeModules, field: 'snapshot node_modules' })
  const digest = await canonicalTreeFingerprint(snapshotNodeModules)
  if (digest !== admittedDigest || digest !== record.nodeModulesTreeDigest)
    fail(
      `existing snapshot digest mismatch: expected=${admittedDigest} recorded=${record.nodeModulesTreeDigest} actual=${digest}`,
    )
}

const publishCurrentPointer = ({
  paths,
  fingerprint,
  token,
}: {
  paths: ViewPaths
  fingerprint: string
  token: string
}): void => {
  const linkTarget = `.store/${currentName}-${fingerprint}`
  if (pathExists(paths.current) === true && lstatSync(paths.current).isSymbolicLink() === false)
    fail(`current view path is not a symlink: ${paths.current}`)
  const candidate = join(paths.editorRoot, `.${currentName}.candidate-${token}`)
  try {
    symlinkSync(linkTarget, candidate)
    renameSync(candidate, paths.current)
  } finally {
    if (pathExists(candidate) === true) rmSync(candidate)
  }
}

const describeIdentity = (path: string): string => {
  const status = lstatSync(path, { bigint: true })
  return `${status.dev}:${status.ino}:${status.mode}`
}

const adoptFirstHop = ({
  paths,
  mv,
  token,
}: {
  paths: ViewPaths
  mv: string
  token: string
}): void => {
  if (pathExists(paths.firstHop) === true) {
    const status = lstatSync(paths.firstHop)
    if (status.isSymbolicLink() === true && readlinkSync(paths.firstHop) === firstHopTarget) {
      let resolved: string
      try {
        resolved = realpathSync(paths.firstHop)
      } catch (error) {
        return fail(
          `existing first-hop symlink is dangling: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const expected = realpathSync(join(paths.current, 'node_modules'))
      if (resolved !== expected)
        fail(`existing first-hop symlink resolves to unexpected tree: ${resolved}`)
      return
    }
    ensureRealDirectory({ path: paths.legacyDir, field: 'legacy directory' })
    const legacyCandidate = join(paths.legacyDir, `.candidate-${token}`)
    const retained = join(paths.legacyDir, `node_modules-${token}`)
    let exchanged = false
    try {
      symlinkSync(firstHopTarget, legacyCandidate)
      const oldIdentity = describeIdentity(paths.firstHop)
      runTool({
        tool: mv,
        args: ['--exchange', '--no-copy', '-T', legacyCandidate, paths.firstHop],
        label: 'mv --exchange',
      })
      exchanged = true
      if (
        lstatSync(paths.firstHop).isSymbolicLink() === false ||
        readlinkSync(paths.firstHop) !== firstHopTarget
      )
        fail(`first-hop exchange did not install the expected symlink: ${paths.firstHop}`)
      if (describeIdentity(legacyCandidate) !== oldIdentity)
        fail(`first-hop exchange did not retain the legacy entry: ${legacyCandidate}`)
    } finally {
      if (pathExists(legacyCandidate) === true) {
        if (exchanged === true) renameSync(legacyCandidate, retained)
        else rmSync(legacyCandidate)
      }
    }
    return
  }
  const candidate = join(paths.packageDir, `.node_modules.candidate-${token}`)
  try {
    symlinkSync(firstHopTarget, candidate)
    renameSync(candidate, paths.firstHop)
  } finally {
    if (pathExists(candidate) === true) rmSync(candidate)
  }
}

/** Publish or validate the immutable snapshot selected by the admitted editor inputs. */
export const publishEditorView = async (options: EditorViewOptions): Promise<EditorViewRecord> => {
  requireScopedRecordIdentity(options)
  const paths = makePaths(options)
  requireDirectory({ path: options.editorInputs, field: 'editor_inputs' })
  requireDirectory({ path: options.nodeModules, field: 'admitted node_modules' })
  requireImmutableTool({ tool: options.cp, label: 'cp -al' })
  requireImmutableTool({ tool: options.mv, label: 'mv --exchange' })
  ensureRealDirectory({ path: paths.editorRoot, field: 'editor root' })
  ensureRealDirectory({ path: paths.storeDir, field: 'editor snapshot store' })
  if (statSync(options.nodeModules).dev !== statSync(paths.storeDir).dev)
    fail('admitted node_modules and editor snapshot store are on different filesystems')
  const lock = acquireLock({
    editorRoot: paths.editorRoot,
    recoveryCommand: `recover-lock --repo-root ${paths.repoRoot} --package ${options.package}`,
  })
  let candidate: string | undefined
  try {
    const fingerprint = await canonicalTreeFingerprint(options.editorInputs)
    const nodeModulesTreeDigest = await canonicalTreeFingerprint(options.nodeModules)
    const record = expectedRecord({ options, fingerprint, nodeModulesTreeDigest })
    const snapshotDir = join(paths.editorRoot, record.snapshot)
    if (existsSync(snapshotDir) === true) {
      await validateSnapshot({
        snapshotDir,
        expected: record,
        admittedDigest: nodeModulesTreeDigest,
      })
    } else {
      candidate = join(paths.storeDir, `.candidate-${tokenSafe(lock.token)}`)
      mkdirSync(candidate)
      const candidateNodeModules = join(candidate, 'node_modules')
      mkdirSync(candidateNodeModules)
      runTool({
        tool: options.cp,
        args: ['-al', '--', `${resolve(options.nodeModules)}/.`, candidateNodeModules],
        label: 'cp -al',
      })
      assertHardlinkedTrees({
        source: resolve(options.nodeModules),
        snapshot: candidateNodeModules,
      })
      const candidateDigest = await canonicalTreeFingerprint(candidateNodeModules)
      if (candidateDigest !== nodeModulesTreeDigest)
        fail(
          `candidate digest mismatch: source=${nodeModulesTreeDigest} candidate=${candidateDigest}`,
        )
      writeRecord({ path: join(candidate, 'editor-view.json'), record })
      renameSync(candidate, snapshotDir)
      candidate = undefined
    }
    publishCurrentPointer({ paths, fingerprint, token: tokenSafe(lock.token) })
    adoptFirstHop({ paths, mv: options.mv, token: tokenSafe(lock.token) })
    await checkEditorView(options)
    return record
  } finally {
    if (candidate !== undefined && pathExists(candidate) === true)
      rmSync(candidate, { recursive: true, force: true })
    releaseLock(lock)
  }
}

const tokenSafe = (token: string): string => token.replaceAll('-', '')

const inferRecordedFingerprint = (current: string): string => {
  try {
    if (lstatSync(current).isSymbolicLink() === false) return '<invalid-pointer>'
    const match = /^\.store\/tui-core-([0-9a-f]{64})$/.exec(readlinkSync(current))
    return match?.[1] ?? '<invalid-pointer>'
  } catch {
    return '<missing>'
  }
}

/** Validate the live two-hop view against freshly admitted Buck artifacts. */
export const checkEditorView = async (options: EditorViewOptions): Promise<EditorViewRecord> => {
  requireScopedRecordIdentity(options)
  const paths = makePaths(options)
  requireDirectory({ path: options.editorInputs, field: 'editor_inputs' })
  requireDirectory({ path: options.nodeModules, field: 'admitted node_modules' })
  const currentFingerprint = await canonicalTreeFingerprint(options.editorInputs)
  const context: CheckContext = { recordedFingerprint: '<missing>', currentFingerprint }
  try {
    requireDirectory({ path: paths.editorRoot, field: 'editor root' })
    requireDirectory({ path: paths.storeDir, field: 'editor snapshot store' })
  } catch (error) {
    return failCheck({ message: error instanceof Error ? error.message : String(error), context })
  }
  context.recordedFingerprint = inferRecordedFingerprint(paths.current)
  let currentStatus
  try {
    currentStatus = lstatSync(paths.current)
  } catch {
    return failCheck({ message: `current pointer is missing: ${paths.current}`, context })
  }
  if (currentStatus.isSymbolicLink() === false)
    return failCheck({ message: `current pointer is not a symlink: ${paths.current}`, context })
  const pointer = readlinkSync(paths.current)
  const expectedPointer = `.store/${currentName}-${context.recordedFingerprint}`
  if (pointer !== expectedPointer)
    return failCheck({ message: `current pointer is escaping or malformed: ${pointer}`, context })
  const snapshotDir = resolve(paths.editorRoot, pointer)
  if (isWithin({ root: paths.storeDir, candidate: snapshotDir }) === false)
    return failCheck({ message: `current pointer escapes snapshot store: ${pointer}`, context })
  try {
    requireDirectory({ path: snapshotDir, field: 'current snapshot' })
  } catch (error) {
    return failCheck({
      message: `current pointer is dangling: ${error instanceof Error ? error.message : String(error)}`,
      context,
    })
  }
  let record: EditorViewRecord
  try {
    record = readRecord(join(snapshotDir, 'editor-view.json'))
  } catch (error) {
    return failCheck({ message: error instanceof Error ? error.message : String(error), context })
  }
  context.recordedFingerprint = record.editorInputsFingerprint
  const expected = expectedRecord({
    options,
    fingerprint: record.editorInputsFingerprint,
    nodeModulesTreeDigest: record.nodeModulesTreeDigest,
  })
  if (recordsEqual({ left: record, right: expected }) === false)
    return failCheck({ message: 'record package/cell/target/snapshot fields are invalid', context })
  if (record.editorInputsFingerprint !== currentFingerprint)
    return failCheck({ message: 'editor_inputs fingerprint mismatch', context })
  const admittedDigest = await canonicalTreeFingerprint(options.nodeModules)
  if (admittedDigest !== record.nodeModulesTreeDigest)
    return failCheck({
      message: `admitted node_modules digest mismatch: recorded=${record.nodeModulesTreeDigest} admitted=${admittedDigest}`,
      context,
    })
  const snapshotNodeModules = join(snapshotDir, 'node_modules')
  let snapshotDigest: string
  try {
    snapshotDigest = await canonicalTreeFingerprint(snapshotNodeModules)
  } catch (error) {
    return failCheck({
      message: `snapshot is incomplete: ${error instanceof Error ? error.message : String(error)}`,
      context,
    })
  }
  if (snapshotDigest !== record.nodeModulesTreeDigest)
    return failCheck({
      message: `snapshot node_modules digest mismatch: recorded=${record.nodeModulesTreeDigest} snapshot=${snapshotDigest}`,
      context,
    })
  let firstHopStatus
  try {
    firstHopStatus = lstatSync(paths.firstHop)
  } catch {
    return failCheck({
      message: `first-hop node_modules pointer is missing: ${paths.firstHop}`,
      context,
    })
  }
  if (firstHopStatus.isSymbolicLink() === false || readlinkSync(paths.firstHop) !== firstHopTarget)
    return failCheck({
      message: `first-hop node_modules pointer is escaping or malformed: ${paths.firstHop}`,
      context,
    })
  let firstHopResolved: string
  try {
    firstHopResolved = realpathSync(paths.firstHop)
  } catch (error) {
    return failCheck({
      message: `first-hop node_modules pointer is dangling: ${error instanceof Error ? error.message : String(error)}`,
      context,
    })
  }
  if (firstHopResolved !== realpathSync(snapshotNodeModules))
    return failCheck({
      message: `first-hop node_modules pointer resolves outside current snapshot: ${firstHopResolved}`,
      context,
    })
  return record
}

type ParsedCli = {
  readonly command: 'publish' | 'check' | 'recover-lock'
  readonly options: EditorViewOptions
  readonly token: string | undefined
}

const parseCli = (args: readonly string[]): ParsedCli => {
  const command = args[0]
  if (command !== 'publish' && command !== 'check' && command !== 'recover-lock')
    return fail('expected command: publish, check, or recover-lock')
  const values = new Map<string, string>()
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index] ?? fail('missing option')
    const value = args[index + 1] ?? fail(`missing value for ${flag}`)
    if (flag.startsWith('--') === false || values.has(flag) === true)
      fail(`unexpected or duplicate option: ${flag}`)
    values.set(flag, value)
  }
  const recover = command === 'recover-lock'
  const allowed = new Set(
    recover === true
      ? ['--repo-root', '--package', '--token']
      : [
          '--repo-root',
          '--package',
          '--cell',
          '--target',
          '--editor-inputs',
          '--node-modules',
          '--cp',
          '--mv',
        ],
  )
  for (const flag of values.keys())
    if (allowed.has(flag) === false) fail(`unexpected option for ${command}: ${flag}`)
  const get = (flag: string): string => values.get(flag) ?? fail(`missing required option ${flag}`)
  const getUnlessRecovering = (flag: string): string => (recover === true ? '' : get(flag))
  const options: EditorViewOptions = {
    repoRoot: get('--repo-root'),
    package: get('--package'),
    cell: getUnlessRecovering('--cell'),
    target: getUnlessRecovering('--target'),
    editorInputs: getUnlessRecovering('--editor-inputs'),
    nodeModules: getUnlessRecovering('--node-modules'),
    cp: getUnlessRecovering('--cp'),
    mv: getUnlessRecovering('--mv'),
  }
  return { command, options, token: recover === true ? get('--token') : undefined }
}

const main = async (): Promise<void> => {
  const parsed = parseCli(process.argv.slice(2))
  if (parsed.command === 'publish') {
    const record = await publishEditorView(parsed.options)
    process.stdout.write(
      `published ${record.package} editor view ${record.editorInputsFingerprint}\n`,
    )
  } else if (parsed.command === 'check') {
    const record = await checkEditorView(parsed.options)
    process.stdout.write(
      `checked ${record.package} editor view ${record.editorInputsFingerprint}\n`,
    )
  } else {
    recoverEditorViewLock({
      options: parsed.options,
      token: parsed.token ?? fail('missing required option --token'),
    })
    process.stdout.write('recovered editor view publication lock\n')
  }
}

if (import.meta.main === true) await main()
