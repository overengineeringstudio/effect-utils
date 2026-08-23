import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import process from 'node:process'

const [mode, workspaceArg, stageArg, ...sourcePaths] = process.argv.slice(2)
if (
  !['check', 'gc', 'publish'].includes(mode) ||
  workspaceArg === undefined ||
  stageArg === undefined
) {
  throw new Error(
    'usage: stage-pnpm-source-inputs.mjs <check|gc|publish> <workspace> <stage> [source ...]',
  )
}

const workspaceRoot = await Fs.realpath(workspaceArg)
const parseRelativePath = (value, label) => {
  if (value.length === 0 || Path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path: ${JSON.stringify(value)}`)
  }
  const normalized = Path.posix.normalize(value.replaceAll('\\', '/'))
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} escapes its root: ${JSON.stringify(value)}`)
  }
  return normalized
}

const stagePath = parseRelativePath(stageArg, 'stage path')
const normalizedSources = sourcePaths.map((path) => parseRelativePath(path, 'source path')).sort()
if (new Set(normalizedSources).size !== normalizedSources.length)
  throw new Error('source paths must be unique')

const isWithin = (root, candidate) =>
  candidate === root || candidate.startsWith(`${root}${Path.sep}`)
const stageRoot = Path.resolve(workspaceRoot, stagePath)
const generationsRoot = Path.join(stageRoot, 'generations')
const currentPath = Path.join(stageRoot, 'current')
if (!isWithin(workspaceRoot, stageRoot))
  throw new Error(`stage path escapes workspace: ${stageRoot}`)

const assertNoSymlinkAncestors = async (root, target) => {
  let current = root
  for (const segment of Path.relative(root, target).split(Path.sep)) {
    current = Path.join(current, segment)
    try {
      if ((await Fs.lstat(current)).isSymbolicLink())
        throw new Error(`staging ancestor is a symlink: ${current}`)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

const sourceRoots = new Map()
for (const sourcePath of normalizedSources) {
  const lexicalPath = Path.resolve(workspaceRoot, sourcePath)
  if (!isWithin(workspaceRoot, lexicalPath))
    throw new Error(`source escapes workspace: ${sourcePath}`)
  if (isWithin(stageRoot, lexicalPath) || isWithin(lexicalPath, stageRoot))
    throw new Error(`source overlaps reserved staging state: ${sourcePath}`)
  const resolvedPath = await Fs.realpath(lexicalPath)
  if (isWithin(stageRoot, resolvedPath) || isWithin(resolvedPath, stageRoot))
    throw new Error(`resolved source overlaps reserved staging state: ${sourcePath}`)
  if (!(await Fs.stat(resolvedPath)).isDirectory())
    throw new Error(`source is not a directory: ${sourcePath}`)
  sourceRoots.set(sourcePath, resolvedPath)
}

const ignoredName = (name) => name === '.git' || name === 'node_modules'
const hashTree = async (root) => {
  const hash = Crypto.createHash('sha256')
  const visit = async (current, relative = '') => {
    const entries = (await Fs.readdir(current, { withFileTypes: true }))
      .filter((entry) => !ignoredName(entry.name))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      const entryPath = Path.join(current, entry.name)
      const entryRelative = Path.posix.join(relative, entry.name)
      if (entry.isSymbolicLink()) {
        const resolved = await Fs.realpath(entryPath)
        if (!isWithin(root, resolved))
          throw new Error(`source symlink escapes package: ${entryPath} -> ${resolved}`)
        const stat = await Fs.stat(resolved)
        if (stat.isDirectory()) {
          throw new Error(`source directory symlink is not supported: ${entryPath}`)
        } else {
          hash.update(`file\0${entryRelative}\0${stat.mode & 0o111 ? 1 : 0}\0`)
          hash.update(await Fs.readFile(resolved))
        }
      } else if (entry.isDirectory()) {
        hash.update(`dir\0${entryRelative}\0`)
        await visit(entryPath, entryRelative)
      } else if (entry.isFile()) {
        const stat = await Fs.stat(entryPath)
        hash.update(`file\0${entryRelative}\0${stat.mode & 0o111 ? 1 : 0}\0`)
        hash.update(await Fs.readFile(entryPath))
      }
    }
  }
  await visit(root)
  return hash.digest('hex')
}

const sourceIdentity = async () => {
  const entries = []
  for (const [sourcePath, sourceRoot] of sourceRoots)
    entries.push([sourcePath, await hashTree(sourceRoot)])
  const encoded = JSON.stringify(entries)
  return { entries, identity: Crypto.createHash('sha256').update(encoded).digest('hex') }
}

const validatePublished = async (expected) => {
  const currentRoot = await Fs.realpath(currentPath)
  if (!isWithin(generationsRoot, currentRoot))
    throw new Error('published generation escapes staging root')
  const manifest = JSON.parse(
    await Fs.readFile(Path.join(currentRoot, '.source-inputs.json'), 'utf8'),
  )
  if (
    manifest.identity !== expected.identity ||
    JSON.stringify(manifest.entries) !== JSON.stringify(expected.entries)
  ) {
    throw new Error('published source generation identity is stale')
  }
  for (const [sourcePath, expectedHash] of expected.entries) {
    if ((await hashTree(Path.join(currentRoot, sourcePath))) !== expectedHash) {
      throw new Error(`published source generation drifted: ${sourcePath}`)
    }
  }
}

const makeReadonly = async (root) => {
  for (const entry of await Fs.readdir(root, { withFileTypes: true })) {
    const entryPath = Path.join(root, entry.name)
    if (entry.isDirectory()) {
      await makeReadonly(entryPath)
      await Fs.chmod(entryPath, 0o555)
    } else {
      const stat = await Fs.stat(entryPath)
      await Fs.chmod(entryPath, stat.mode & 0o111 ? 0o555 : 0o444)
    }
  }
}

const makeWritable = async (root) => {
  await Fs.chmod(root, 0o755)
  for (const entry of await Fs.readdir(root, { withFileTypes: true })) {
    const entryPath = Path.join(root, entry.name)
    if (entry.isDirectory()) await makeWritable(entryPath)
  }
}

await assertNoSymlinkAncestors(workspaceRoot, stageRoot)
const before = await sourceIdentity()
if (mode === 'check') {
  await validatePublished(before)
  process.exit(0)
}

if (mode === 'gc') {
  await validatePublished(before)
  const currentRoot = await Fs.realpath(currentPath)
  for (const entry of await Fs.readdir(generationsRoot, { withFileTypes: true })) {
    const candidate = Path.join(generationsRoot, entry.name)
    if (!entry.isDirectory() || candidate === currentRoot) continue
    await makeWritable(candidate)
    await Fs.rm(candidate, { force: true, recursive: true })
  }
  process.exit(0)
}

try {
  await validatePublished(before)
  process.exit(0)
} catch (error) {
  if (String(error).includes('escapes staging root')) throw error
}

await Fs.mkdir(generationsRoot, { recursive: true })
const nextRoot = await Fs.mkdtemp(Path.join(generationsRoot, '.next-'))
try {
  for (const [sourcePath, sourceRoot] of sourceRoots) {
    const target = Path.join(nextRoot, sourcePath)
    await Fs.mkdir(Path.dirname(target), { recursive: true })
    await Fs.cp(sourceRoot, target, {
      dereference: true,
      recursive: true,
      filter: (path) => !ignoredName(Path.basename(path)),
    })
  }
  const after = await sourceIdentity()
  if (JSON.stringify(after) !== JSON.stringify(before))
    throw new Error('canonical source changed during staging')
  for (const [sourcePath, expectedHash] of before.entries) {
    if ((await hashTree(Path.join(nextRoot, sourcePath))) !== expectedHash) {
      throw new Error(`constructed generation differs from canonical source: ${sourcePath}`)
    }
  }
  await Fs.writeFile(
    Path.join(nextRoot, '.source-inputs.json'),
    `${JSON.stringify(before, undefined, 2)}\n`,
  )
  await makeReadonly(nextRoot)
  const generationRoot = Path.join(generationsRoot, `${before.identity}-${Crypto.randomUUID()}`)
  await Fs.rename(nextRoot, generationRoot)
  await Fs.chmod(generationRoot, 0o555)
  const pointer = Path.join(stageRoot, `.current-${process.pid}-${Crypto.randomUUID()}`)
  await Fs.symlink(Path.relative(stageRoot, generationRoot), pointer)
  await Fs.rename(pointer, currentPath)
  await validatePublished(before)
} catch (error) {
  try {
    await makeWritable(nextRoot)
  } catch (cleanupError) {
    if (cleanupError?.code !== 'ENOENT') throw cleanupError
  }
  await Fs.rm(nextRoot, { force: true, recursive: true })
  throw error
}
