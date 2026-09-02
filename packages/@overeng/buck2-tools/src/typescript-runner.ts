/* oxlint-disable overeng/exports-first -- Focused tests import narrow seams beside the private helpers they exercise. */
import { createHash, type Hash } from 'node:crypto'
import { createReadStream, type Stats } from 'node:fs'
import {
  chmod,
  copyFile,
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
import { fileURLToPath } from 'node:url'

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
  readonly declarationSources: readonly string[]
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

const requireArgument = (options: {
  readonly args: readonly string[]
  readonly index: number
  readonly name: string
}): string => options.args[options.index] ?? fail(`missing ${options.name}`)

const requireExactArgumentCount = (options: {
  readonly args: readonly string[]
  readonly command: string
  readonly count: number
}): void => {
  if (options.args.length !== options.count)
    fail(`${options.command} expected ${options.count} arguments, received ${options.args.length}`)
}

const requireNormalizedRelativePath = (options: {
  readonly name: string
  readonly value: string
}): string => {
  const { name, value } = options
  if (
    value.length === 0 ||
    isAbsolute(value) === true ||
    value.includes('\\') === true ||
    value
      .split('/')
      .some((component) => component === '' || component === '.' || component === '..') === true
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
  requireExactArgumentCount({ args, command: 'typecheck', count: 4 })
  return {
    tsgo: requireTsgo(requireArgument({ args, index: 0, name: 'tsgo' })),
    packageTree: requireArgument({ args, index: 1, name: 'package tree' }),
    project: requireNormalizedRelativePath({
      name: 'project',
      value: requireArgument({ args, index: 2, name: 'project' }),
    }),
    verdict: requireArgument({ args, index: 3, name: 'verdict' }),
  }
}

/** Parses the fail-closed emit command contract for focused rule/runner tests. */
export const parseEmitOptions = (args: readonly string[]): EmitOptions => {
  if (args.length < 6 || (args.length - 6) % 2 !== 0) {
    fail(
      `emit expected 6 arguments followed by declaration flag/path pairs, received ${args.length}`,
    )
  }
  const declarationSources: string[] = []
  for (let index = 6; index < args.length; index += 2) {
    const flag = requireArgument({ args, index, name: 'declaration flag' })
    if (flag !== '--copy-declaration') fail(`unexpected emit argument: ${flag}`)
    declarationSources.push(
      requireNormalizedRelativePath({
        name: 'declaration source',
        value: requireArgument({ args, index: index + 1, name: 'declaration source' }),
      }),
    )
  }
  return {
    tsgo: requireTsgo(requireArgument({ args, index: 0, name: 'tsgo' })),
    packageTree: requireArgument({ args, index: 1, name: 'package tree' }),
    project: requireNormalizedRelativePath({
      name: 'project',
      value: requireArgument({ args, index: 2, name: 'project' }),
    }),
    outDir: requireNormalizedRelativePath({
      name: 'out dir',
      value: requireArgument({ args, index: 3, name: 'out dir' }),
    }),
    declarationEntrypoint: requireNormalizedRelativePath({
      name: 'declaration entrypoint',
      value: requireArgument({ args, index: 4, name: 'declaration entrypoint' }),
    }),
    output: requireArgument({ args, index: 5, name: 'output' }),
    declarationSources,
  }
}

const updateFramedText = (options: { readonly hash: Hash; readonly value: string }): void => {
  const { hash, value } = options
  const bytes = Buffer.from(value)
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(bytes.byteLength)
  hash.update(length)
  hash.update(bytes)
}

const forEachSequential = async <T>(options: {
  readonly iterator: Iterator<T> | AsyncIterator<T>
  readonly visit: (value: T) => void | Promise<void>
}): Promise<void> => {
  const next = await options.iterator.next()
  if (next.done === true) return
  await options.visit(next.value)
  await forEachSequential(options)
}

const hashTree = async (root: string): Promise<string> => {
  const hash = createHash('sha256')

  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path)
    const entry = relative(root, path).split(sep).join('/') || '.'
    updateFramedText({ hash, value: entry })
    updateFramedText({ hash, value: String(metadata.mode & 0o7777) })

    if (metadata.isDirectory() === true) {
      updateFramedText({ hash, value: 'directory' })
      const children = (await readdir(path)).toSorted()
      await forEachSequential({
        iterator: children.values(),
        visit: async (child) => visit(join(path, child)),
      })
      return
    }
    if (metadata.isSymbolicLink() === true) {
      updateFramedText({ hash, value: 'symlink' })
      updateFramedText({ hash, value: await readlink(path) })
      return
    }
    if (metadata.isFile() === true) {
      updateFramedText({ hash, value: 'file' })
      await forEachSequential({
        iterator: createReadStream(path)[Symbol.asyncIterator](),
        visit: (chunk) => {
          hash.update(chunk)
        },
      })
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
    if (isErrnoException(error) === true && error.code === 'ENOENT') return false
    throw error
  }
}

const makeTreeReadOnly = async (path: string): Promise<void> => {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() === true) return
  if (metadata.isDirectory() === true) {
    await forEachSequential({
      iterator: (await readdir(path)).values(),
      visit: async (child) => makeTreeReadOnly(join(path, child)),
    })
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
    if (isErrnoException(error) === true && error.code === 'ENOENT') return
    throw error
  }
  if (metadata.isSymbolicLink() === true) return
  if (metadata.isDirectory() === true) {
    await chmod(path, metadata.mode | 0o700)
    await forEachSequential({
      iterator: (await readdir(path)).values(),
      visit: async (child) => makeTreeRemovable(join(path, child)),
    })
    return
  }
  if (metadata.isFile() === false)
    fail(`unsupported filesystem entry while cleaning staging: ${path}`)
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

const prepareStagedOutput = async (options: {
  readonly outDir: string
  readonly output: string
  readonly packageRoot: string
}): Promise<void> => {
  const { outDir, output, packageRoot } = options
  let current = packageRoot
  await ensureWritableDirectory(current)
  const parentComponents = dirname(outDir) === '.' ? [] : dirname(outDir).split('/')
  await forEachSequential({
    iterator: parentComponents.values(),
    visit: async (component) => {
      current = join(current, component)
      if ((await pathExists(current)) === true) await ensureWritableDirectory(current)
      else await mkdir(current, { mode: 0o700 })
    },
  })

  const stagedOutput = join(packageRoot, outDir)
  await removeTree(stagedOutput)
  await removeTree(output)
  await mkdir(output, { recursive: true })
  await symlink(resolve(output), stagedOutput)
}

/** Copies only the explicitly action-keyed declaration sources into an emitted dist. */
export const copyDeclarationSources = async (options: {
  readonly declarationSources: readonly string[]
  readonly output: string
  readonly packageRoot: string
}): Promise<void> => {
  await forEachSequential({
    iterator: options.declarationSources.values(),
    visit: async (candidate) => {
      const relativePath = requireNormalizedRelativePath({
        name: 'declaration source',
        value: candidate,
      })
      const source = join(options.packageRoot, relativePath)
      let metadata: Stats
      try {
        metadata = await lstat(source)
      } catch (error) {
        if (isErrnoException(error) === true && error.code === 'ENOENT') {
          fail(`declaration source does not exist: ${relativePath}`)
        }
        throw error
      }
      if (metadata.isFile() === false) {
        fail(`declaration source is not a regular file: ${relativePath}`)
      }
      const destination = join(options.output, relativePath)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
    },
  })
}

const validateOutput = async (options: {
  readonly declarationEntrypoint: string
  readonly output: string
}): Promise<void> => {
  const { declarationEntrypoint, output } = options
  const expected = join(output, declarationEntrypoint)
  let expectedMetadata: Stats
  try {
    expectedMetadata = await lstat(expected)
  } catch (error) {
    if (isErrnoException(error) === true && error.code === 'ENOENT') {
      fail(`expected declaration entrypoint was not emitted: ${declarationEntrypoint}`)
    }
    throw error
  }
  if (expectedMetadata.isFile() === false) {
    fail(`expected declaration entrypoint is not a regular file: ${declarationEntrypoint}`)
  }

  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() === true)
      fail(`emitted output must not contain symlinks: ${path}`)
    if (metadata.isDirectory() === true) {
      await forEachSequential({
        iterator: (await readdir(path)).values(),
        visit: async (child) => visit(join(path, child)),
      })
      return
    }
    if (metadata.isFile() === false) fail(`unsupported emitted filesystem entry: ${path}`)
  }
  await visit(output)
}

const runTsgo = async (options: {
  readonly argv: readonly string[]
  readonly cwd: string
}): Promise<number> => {
  if (forwardedSignal !== undefined) return 128 + signalNumbers[forwardedSignal]
  const child = Bun.spawn([...options.argv], {
    cwd: options.cwd,
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
    status = await runTsgo({
      argv: [
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
      cwd: packageTree,
    })
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
    await prepareStagedOutput({ outDir: options.outDir, output, packageRoot })
    await makeTreeReadOnly(packageRoot)
    status = await runTsgo({
      argv: [
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
      cwd: packageRoot,
    })
    if (status === 0) {
      await copyDeclarationSources({
        declarationSources: options.declarationSources,
        output,
        packageRoot,
      })
      await validateOutput({ declarationEntrypoint: options.declarationEntrypoint, output })
    }
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
  if (cleanupError !== undefined)
    console.error(`typescript runner cleanup failed: ${formatError(cleanupError)}`)
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

/** Runs the hermetic TypeScript action selected by the Buck rule command. */
export const runTypeScriptCli = async (args: readonly string[]): Promise<number> => {
  const [command, ...commandArgs] = args
  if (command === 'typecheck') return runTypecheck(parseTypecheckOptions(commandArgs))
  if (command === 'emit') return runEmit(parseEmitOptions(commandArgs))
  return fail(`expected command "typecheck" or "emit", received ${command ?? '<missing>'}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installSignalForwarding()
  let status = 1
  try {
    status = await runTypeScriptCli(process.argv.slice(2))
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
}
