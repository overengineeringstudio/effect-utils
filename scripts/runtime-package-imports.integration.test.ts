import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'

import cacheTargets from '../nix/buck2-products/cache-targets.json'

type ExportTarget = string | { [condition: string]: ExportTarget }

type PackageManifest = {
  exports?: Record<string, ExportTarget>
  name: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  publishConfig?: { exports?: Record<string, ExportTarget> }
}

const root = resolve(import.meta.dir, '..')
const products = cacheTargets.products.filter((product) => product.kind === 'package')
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))
const scanners = {
  '.js': new Bun.Transpiler({ loader: 'js' }),
  '.ts': new Bun.Transpiler({ loader: 'ts' }),
  '.tsx': new Bun.Transpiler({ loader: 'tsx' }),
}

const barePackageName = (specifier: string): string =>
  specifier.startsWith('@') === true
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]!

const exportPaths = (entry: ExportTarget): string[] =>
  typeof entry === 'string' ? [entry] : Object.values(entry).flatMap(exportPaths)

const runtimeImportViolations = (manifest: PackageManifest, packageRoot: string): string[] => {
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
  const visited = new Set<string>()
  const violations: string[] = []
  const sourceEntries = Object.values(manifest.exports ?? {})
    .flatMap(exportPaths)
    .filter((entry) => existsSync(resolve(packageRoot, entry)) === true)
  const publishedEntries = Object.values(manifest.publishConfig?.exports ?? {})
    .flatMap(exportPaths)
    .filter((entry) => existsSync(resolve(packageRoot, entry)) === true)
  const pending = [...sourceEntries, ...publishedEntries]
    .filter((entry) => /\.(?:js|ts|tsx)$/.test(entry) && entry.endsWith('.d.ts') === false)
    .map((entry) => resolve(packageRoot, entry))
  if (pending.length === 0) throw new Error(`${manifest.name} has no shipped runtime entry`)

  while (pending.length > 0) {
    const file = pending.pop()!
    if (visited.has(file) === true) continue
    visited.add(file)
    if (existsSync(file) === false)
      throw new Error(`${manifest.name}: missing shipped runtime file ${file}`)
    const extension = extname(file) as keyof typeof scanners
    const scanner = scanners[extension]
    if (scanner === undefined) continue
    for (const { path: specifier } of scanner.scanImports(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.') === true || specifier.startsWith('/') === true) {
        const target = resolve(dirname(file), specifier)
        if (existsSync(target) === true) pending.push(target)
        else if (target.endsWith('.js') === true) {
          const source = target.replace(/\.js$/, '.ts')
          if (existsSync(source) === true) pending.push(source)
        }
        continue
      }
      const packageName = barePackageName(specifier)
      if (
        specifier.startsWith('node:') === true ||
        specifier.startsWith('bun:') === true ||
        builtins.has(packageName) === true ||
        packageName === manifest.name ||
        declared.has(packageName) === true
      )
        continue
      violations.push(
        `${manifest.name}: ${file.slice(packageRoot.length + 1)} imports ${specifier} without a runtime dependency`,
      )
    }
  }
  return violations
}

test('all cache package products declare imports reachable from their shipped runtime exports', () => {
  const targets = products.map((product) => product.target)
  const build = Bun.spawnSync(
    [process.env.BUCK2_BIN ?? 'buck2', 'build', '--show-output', '--local-only', ...targets],
    {
      cwd: root,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  if (build.exitCode !== 0) {
    throw new Error(
      `Buck package build failed:\n${build.stderr.toString()}\n${build.stdout.toString()}`,
    )
  }
  const output = new Map(
    build.stdout
      .toString()
      .trim()
      .split('\n')
      .map((line) => {
        const match = line.match(/^(\S+)\s+(.+)$/)
        if (match === null) throw new Error(`Unexpected Buck output: ${line}`)
        return [match[1]!, match[2]!] as const
      }),
  )
  const stage = mkdtempSync(join(tmpdir(), 'effect-utils-package-imports-'))
  try {
    const violations = products.flatMap((product, index) => {
      const path = output.get(product.target)
      if (path === undefined) throw new Error(`Buck did not report an output for ${product.target}`)
      const archive = isAbsolute(path) === true ? path : join(root, path)
      const extraction = join(stage, String(index))
      mkdirSync(extraction)
      const unpack = Bun.spawnSync(['tar', '-xzf', archive, '-C', extraction])
      if (unpack.exitCode !== 0)
        throw new Error(`Cannot extract ${product.name}: ${unpack.stderr.toString()}`)
      const packageRoot = join(extraction, 'package')
      const manifest = JSON.parse(
        readFileSync(join(packageRoot, 'package.json'), 'utf8'),
      ) as PackageManifest
      return runtimeImportViolations(manifest, packageRoot)
    })
    expect(violations).toEqual([])
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}, 900_000)
