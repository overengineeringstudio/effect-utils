import { createHash, type Hash } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const signalNumbers = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
} as const

type ForwardedSignal = keyof typeof signalNumbers

type TypecheckOptions = {
  readonly packageTree: string
  readonly project: string
  readonly tsgo: string
  readonly verdict: string
}

type EmitOptions = {
  readonly declarationEntrypoint: string
  readonly outDir: string
  readonly output: string
  readonly packageTree: string
  readonly project: string
  readonly tsgo: string
}

let activeChild: ReturnType<typeof Bun.spawn> | undefined
let forwardedSignal: ForwardedSignal | undefined

const fail = (message: string): never => {
  throw new Error(`typescript runner: ${message}`)
}

const formatError = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error)

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error

const requireArgument = (args: readonly string[], index: number, name: string): string =>
  args[index] ?? fail(`missing ${name}`)

const requireExactArgumentCount = (args: readonly string[], count: number, command: string): void => {
  if (args.length !== count) fail(`${command} expected ${count} arguments, received ${args.length}`)
}

const requireNormalizedRelativePath = (value: string, name: string): string => {
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((component) => component === '' || component === '.' || component === '..')
  ) {
    fail(`${name} must be a normalized portable relative path: ${value}`)
  }
  return value
}

const requireTsgo = (value: string): string => {
  if (value.startsWith('/nix/store/') === false || basename(value) !== 'tsgo') {
    fail(`tsgo must be an immutable /nix/store executable: ${value}`)
  }
  return value
}

const parseTypecheckOptions = (args: readonly string[]): TypecheckOptions => {
  requireExactArgumentCount(args, 4, 'typecheck')
  return {
    tsgo: requireTsgo(requireArgument(args, 0, 'tsgo')),
    packageTree: requireArgument(args, 1, 'package tree'),
    project: requireNormalizedRelativePath(requireArgument(args, 2, 'project'), 'project'),
    verdict: requireArgument(args, 3, 'verdict'),
  }
}

const parseEmitOptions = (args: readonly string[]): EmitOptions => {
  requireExactArgumentCount(args, 6, 'emit')
  return {
    tsgo: requireTsgo(requireArgument(args, 0, 'tsgo')),
    packageTree: requireArgument(args, 1, 'package tree'),
    project: requireNormalizedRelativePath(requireArgument(args, 2, 'project'), 'project'),
    outDir: requireNormalizedRelativePath(requireArgument(args, 3, 'out dir'), 'out dir'),
    declarationEntrypoint: requireNormalizedRelativePath(
      requireArgument(args, 4, 'declaration entrypoint'),
      'declaration entrypoint',
    ),
    output: requireArgument(args, 5, 'output'),
  }
}

const updateFramedText = (hash: Hash, value: string): void => {
  const bytes = Buffer.from(value)
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(bytes.byteLength)
  hash.update(length)
  hash.update(bytes)
}

const hashTree = async (root: string): Promise<string> => {
  const hash = createHash('sha256')

  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path)
    const entry = relative(root, path).split(sep).join('/') || '.'
    updateFramedText(hash, entry)
    updateFramedText(hash, String(metadata.mode & 0o7777))

    if (metadata.isDirectory()) {
      updateFramedText(hash, 'directory')
      const children = (await readdir(path)).sort()
      for (const child of children) await visit(join(path, child))
      return
    }
    if (metadata.isSymbolicLink()) {
      updateFramedText(hash, 'symlink')
      updateFramedText(hash, await readlink(path))
      return
    }
    if (metadata.isFile()) {
      updateFramedText(hash, 'file')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      return
    }
    fail(`unsupported filesystem entry while hashing: ${path}`)
  }

  await visit(root)
  return hash.digest('hex')
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false
    throw error
  }
}

const makeTreeReadOnly = async (path: string): Promise<void> => {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) return
  if (metadata.isDirectory()) {
    for (const child of await readdir(path)) await makeTreeReadOnly(join(path, child))
  } else if (metadata.isFile() === false) {
    fail(`unsupported filesystem entry while making staging read-only: ${path}`)
  }
  await chmod(path, metadata.mode & ~0o222)
}

const makeTreeRemovable = async (path: string): Promise<void> => {
  let metadata: Stats
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return
    throw error
  }
  if (metadata.isSymbolicLink()) return
  if (metadata.isDirectory()) {
    await chmod(path, metadata.mode | 0o700)
    for (const child of await readdir(path)) await makeTreeRemovable(join(path, child))
    return
  }
  if (metadata.isFile() === false) fail(`unsupported filesystem entry while cleaning staging: ${path}`)
  await chmod(path, metadata.mode | 0o600)
}

const removeTree = async (path: string): Promise<void> => {
  await makeTreeRemovable(path)
  await rm(path, { force: true, recursive: true })
}

const ensureWritableDirectory = async (path: string): Promise<void> => {
  const metadata = await lstat(path)
  if (metadata.isDirectory() === false) fail(`expected directory in staging path: ${path}`)
  await chmod(path, metadata.mode | 0o700)
}

const prepareStagedOutput = async (
  packageRoot: string,
  outDir: string,
  output: string,
): Promise<void> => {
  let current = packageRoot
  await ensureWritableDirectory(current)
  const parentComponents = dirname(outDir) === '.' ? [] : dirname(outDir).split('/')
  for (const component of parentComponents) {
    current = join(current, component)
    if (await pathExists(current)) await ensureWritableDirectory(current)
    else await mkdir(current, { mode: 0o700 })
  }

  const stagedOutput = join(packageRoot, outDir)
  await removeTree(stagedOutput)
  await removeTree(output)
  await mkdir(output, { recursive: true })
  await symlink(resolve(output), stagedOutput)
}

const validateOutput = async (output: string, declarationEntrypoint: string): Promise<void> => {
  const expected = join(output, declarationEntrypoint)
  let expectedMetadata: Stats
  try {
    expectedMetadata = await lstat(expected)
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      fail(`expected declaration entrypoint was not emitted: ${declarationEntrypoint}`)
    }
    throw error
  }
  if (expectedMetadata.isFile() === false) {
    fail(`expected declaration entrypoint is not a regular file: ${declarationEntrypoint}`)
  }

  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) fail(`emitted output must not contain symlinks: ${path}`)
    if (metadata.isDirectory()) {
      for (const child of await readdir(path)) await visit(join(path, child))
      return
    }
    if (metadata.isFile() === false) fail(`unsupported emitted filesystem entry: ${path}`)
  }
  await visit(output)
}

const runTsgo = async (argv: readonly string[], cwd: string): Promise<number> => {
  if (forwardedSignal !== undefined) return 128 + signalNumbers[forwardedSignal]
  const child = Bun.spawn(argv, {
    cwd,
    env: { ...process.env, PATH: '' },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  activeChild = child
  try {
    return await child.exited
  } finally {
    activeChild = undefined
  }
}

const runTypecheck = async (options: TypecheckOptions): Promise<number> => {
  const packageTree = resolve(options.packageTree)
  const before = await hashTree(packageTree)
  let status = 1
  let compilerError: unknown
  try {
    status = await runTsgo(
      [
        options.tsgo,
        '--project',
        join(packageTree, options.project),
        '--noEmit',
        '--composite',
        'false',
        '--incremental',
        'false',
        '--pretty',
        'false',
      ],
      packageTree,
    )
  } catch (error) {
    compilerError = error
  }

  let invariantError: unknown
  try {
    const after = await hashTree(packageTree)
    if (after !== before) {
      invariantError = new Error(
        `typescript runner: package tree changed during typecheck (before ${before}, after ${after})`,
      )
    }
  } catch (error) {
    invariantError = error
  }

  if (compilerError !== undefined) console.error(formatError(compilerError))
  if (invariantError !== undefined) console.error(formatError(invariantError))
  if (compilerError !== undefined || invariantError !== undefined) return status === 0 ? 1 : status
  if (status !== 0) return status

  await writeFile(options.verdict, `${options.tsgo}\n`)
  return 0
}

const runEmit = async (options: EmitOptions): Promise<number> => {
  const packageTree = resolve(options.packageTree)
  const output = resolve(options.output)
  const stagingRoot = await mkdtemp(join(tmpdir(), 'tsgo-emit-'))
  let status = 1
  let primaryError: unknown

  try {
    const packageRoot = join(stagingRoot, 'package')
    await cp(packageTree, packageRoot, {
      dereference: false,
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    })
    await prepareStagedOutput(packageRoot, options.outDir, output)
    await makeTreeReadOnly(packageRoot)
    status = await runTsgo(
      [
        options.tsgo,
        '--project',
        join(packageRoot, options.project),
        '--outDir',
        join(packageRoot, options.outDir),
        '--noEmit',
        'false',
        '--pretty',
        'false',
      ],
      packageRoot,
    )
    if (status === 0) await validateOutput(output, options.declarationEntrypoint)
  } catch (error) {
    primaryError = error
  }

  let cleanupError: unknown
  try {
    await removeTree(stagingRoot)
  } catch (error) {
    cleanupError = error
  }

  if (primaryError !== undefined) console.error(formatError(primaryError))
  if (cleanupError !== undefined) console.error(`typescript runner cleanup failed: ${formatError(cleanupError)}`)
  if (primaryError !== undefined || cleanupError !== undefined) return status === 0 ? 1 : status
  return status
}

const forwardSignal = (signal: ForwardedSignal): void => {
  forwardedSignal ??= signal
  activeChild?.kill(signalNumbers[signal])
}

const signalHandlers = {
  SIGHUP: (): void => forwardSignal('SIGHUP'),
  SIGINT: (): void => forwardSignal('SIGINT'),
  SIGTERM: (): void => forwardSignal('SIGTERM'),
} satisfies Record<ForwardedSignal, () => void>

const installSignalForwarding = (): void => {
  process.on('SIGHUP', signalHandlers.SIGHUP)
  process.on('SIGINT', signalHandlers.SIGINT)
  process.on('SIGTERM', signalHandlers.SIGTERM)
}

const removeSignalForwarding = (): void => {
  process.removeListener('SIGHUP', signalHandlers.SIGHUP)
  process.removeListener('SIGINT', signalHandlers.SIGINT)
  process.removeListener('SIGTERM', signalHandlers.SIGTERM)
}

const main = async (): Promise<number> => {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'typecheck') return runTypecheck(parseTypecheckOptions(args))
  if (command === 'emit') return runEmit(parseEmitOptions(args))
  fail(`expected command "typecheck" or "emit", received ${command ?? '<missing>'}`)
}

installSignalForwarding()
let status = 1
try {
  status = await main()
} catch (error) {
  console.error(formatError(error))
}
removeSignalForwarding()
if (forwardedSignal !== undefined) {
  const signal = forwardedSignal
  process.kill(process.pid, signal)
  process.exit(128 + signalNumbers[signal])
}
process.exit(status)
