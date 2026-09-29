import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const fail = (reason: string): never => { throw new Error(`pnpm runtime closure: ${reason}`) }
const inside = (root: string, path: string): boolean => {
  const suffix = relative(root, path)
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}
const safeName = (name: string): string => {
  if (!name || name.includes('\\') || name.includes('\0') || isAbsolute(name) || name.split('/').some((part) => !part || part === '.' || part === '..')) fail(`unsafe importer name: ${name}`)
  return name
}
const compare = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right))

type Source = { readonly source: string; readonly destination: string }
export type RuntimeClosureOptions = {
  readonly output: string
  readonly importers: Readonly<Record<string, string>>
  readonly roots: readonly string[]
  readonly primary: string
}

/** Rehomes every declared Buck output, never following source links while copying. */
export const assembleRuntimeClosure = async ({ output, importers, roots, primary }: RuntimeClosureOptions): Promise<void> => {
  const names = Object.keys(importers).sort(compare)
  if (!names.length || !Object.hasOwn(importers, primary)) fail('primary must name a declared importer')
  names.forEach(safeName)
  const stage = `${resolve(output)}.stage-${process.pid}-${crypto.randomUUID()}`
  const canonical = new Set<string>()
  for (const root of roots) {
    const path = await realpath(root)
    if (!(await lstat(path)).isDirectory()) fail(`root is not a directory: ${root}`)
    canonical.add(path)
  }
  for (const name of names) {
    const path = await realpath(importers[name]!)
    if (!canonical.has(path)) fail(`view ${name} is not a declared root: ${path}`)
  }
  const sources: Source[] = [...canonical].sort(compare).map((source, index) => ({ source, destination: join(stage, '.pnpm', String(index)) }))
  const find = (path: string): Source => {
    const source = sources.filter((entry) => inside(entry.source, path)).sort((a, b) => b.source.length - a.source.length)[0]
    return source ?? fail(`link target is outside declared roots: ${path}`)
  }
  const pending: string[] = []
  const walk = async (source: string, destination: string): Promise<void> => {
    const stat = await lstat(source)
    if (stat.isDirectory()) {
      await mkdir(destination, { recursive: true })
      for (const child of (await readdir(source)).sort(compare)) await walk(join(source, child), join(destination, child))
    } else if (stat.isSymbolicLink()) {
      const target = await readlink(source)
      if (isAbsolute(target)) fail(`absolute source symlink: ${source}`)
      const lexical = resolve(dirname(source), target)
      const mapped = find(lexical)
      const destinationTarget = join(mapped.destination, relative(mapped.source, lexical))
      await symlink(relative(dirname(destination), destinationTarget), destination)
      pending.push(destination)
    } else if (stat.isFile()) {
      await copyFile(source, destination)
      await chmod(destination, stat.mode & 0o777)
    } else fail(`unsupported source entry: ${source}`)
  }
  try {
    await mkdir(stage)
    for (const source of sources) await walk(source.source, source.destination)
    for (const link of pending) {
      const resolved = await realpath(link).catch(() => fail(`dangling or cyclic link: ${link}`))
      if (!inside(stage, resolved)) fail(`link escapes closure: ${link}`)
    }
    const primaryView = find(await realpath(importers[primary]!))
    await symlink(relative(stage, primaryView.destination), join(stage, 'node_modules'))
    for (const name of names) {
      const view = find(await realpath(importers[name]!))
      const dir = join(stage, 'importers', name)
      await mkdir(dir, { recursive: true })
      await symlink(relative(dir, view.destination), join(dir, 'node_modules'))
    }
    const digest = await digestRuntimeClosure(stage)
    await writeFile(join(stage, 'descriptor.json'), `${JSON.stringify({ schema: 'effect-utils/pnpm-runtime-closure/v1', digest, importers: names, primary })}\n`)
    await rename(stage, output)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}

/** Hashes path, executable mode, payload and link text without host paths or mtimes. */
export const digestRuntimeClosure = async (root: string): Promise<string> => {
  const hash = createHash('sha256')
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort(compare)) {
      if (prefix === '' && name === 'descriptor.json') continue
      const path = join(dir, name)
      const key = prefix ? `${prefix}/${name}` : name
      const stat = await lstat(path)
      if (stat.isDirectory()) {
        hash.update(`d\0${key}\0`)
        await walk(path, key)
      } else if (stat.isSymbolicLink()) hash.update(`l\0${key}\0${await readlink(path)}\0`)
      else if (stat.isFile()) {
        const bytes = await readFile(path)
        hash.update(`f\0${key}\0${stat.mode & 0o111 ? 'x' : '-'}\0${bytes.length}\0`)
        hash.update(bytes)
      } else fail(`unsupported output entry: ${path}`)
    }
  }
  await walk(root, '')
  return hash.digest('hex')
}

export const verifyRuntimeClosure = async (root: string, expectedDigest: string): Promise<void> => {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) fail('expected digest must be lowercase SHA-256')
  const descriptor: unknown = JSON.parse(await readFile(join(root, 'descriptor.json'), 'utf8'))
  if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor)) fail('invalid descriptor')
  const fields = descriptor as Record<string, unknown>
  if (Object.keys(fields).sort().join(',') !== 'digest,importers,primary,schema' ||
      fields.schema !== 'effect-utils/pnpm-runtime-closure/v1' ||
      fields.digest !== expectedDigest ||
      !Array.isArray(fields.importers) ||
      !fields.importers.every((name) => typeof name === 'string' && safeName(name) === name) ||
      typeof fields.primary !== 'string' ||
      !fields.importers.includes(fields.primary)) fail('invalid runtime closure descriptor')
  if (await digestRuntimeClosure(root) !== expectedDigest) fail('runtime closure digest mismatch')
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  let output = ''
  let primary = ''
  let verificationRoot = ''
  let expectedDigest = ''
  const roots: string[] = []
  const importers: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--root') roots.push(args[++i] ?? fail('missing root'))
    else if (flag === '--view') { const name = args[++i] ?? fail('missing view name'); importers[name] = args[++i] ?? fail('missing view path') }
    else if (flag === '--primary') primary = args[++i] ?? fail('missing primary')
    else if (flag === '--output') output = args[++i] ?? fail('missing output')
    else if (flag === '--verify') verificationRoot = args[++i] ?? fail('missing verify root')
    else if (flag === '--expected-digest') expectedDigest = args[++i] ?? fail('missing expected digest')
    else fail(`unknown argument: ${flag}`)
  }
  if (verificationRoot) await verifyRuntimeClosure(verificationRoot, expectedDigest)
  else {
    if (!output) fail('missing output')
    await assembleRuntimeClosure({ output, primary, roots, importers })
  }
}
