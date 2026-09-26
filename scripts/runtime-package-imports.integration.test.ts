import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'

import cacheTargets from '../nix/buck2-products/cache-targets.json'

type ExportTarget = string | { [condition: string]: ExportTarget }

type PackageManifest = {
  name: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  publishConfig?: { exports?: Record<string, ExportTarget> }
}

const root = resolve(import.meta.dir, '..')
const products = cacheTargets.products.filter((product) => product.kind === 'package')
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))
const scanner = new Bun.Transpiler({ loader: 'js' })

const barePackageName = (specifier: string): string =>
  specifier.startsWith('@') === true
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]!

const exportPaths = (entry: ExportTarget): string[] =>
  typeof entry === 'string' ? [entry] : Object.values(entry).flatMap(exportPaths)

const runtimeImportViolations = (manifest: PackageManifest, dist: string): string[] => {
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
  const visited = new Set<string>()
  const violations: string[] = []
  const exports = Object.values(manifest.publishConfig?.exports ?? {}).flatMap(exportPaths)
  if (exports.length === 0) throw new Error(`${manifest.name} has no published exports`)
  const pending = exports
    .filter((entry) => entry.endsWith('.js'))
    .map((entry) => resolve(dist, entry.replace(/^\.\/dist\//, '')))
  if (pending.length === 0) throw new Error(`${manifest.name} has no published JavaScript entry`)

  while (pending.length > 0) {
    const file = pending.pop()!
    if (visited.has(file) === true) continue
    visited.add(file)
    if (existsSync(file) === false)
      throw new Error(`${manifest.name}: missing published runtime file ${file}`)
    for (const { path: specifier } of scanner.scanImports(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.') === true || specifier.startsWith('/') === true) {
        const target = resolve(dirname(file), specifier)
        if (extname(target) === '.js' && existsSync(target) === true) pending.push(target)
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
        `${manifest.name}: ${file.slice(dist.length + 1)} imports ${specifier} without a runtime dependency`,
      )
    }
  }
  return violations
}

test('all cache package products declare imports reachable from their shipped JavaScript exports', () => {
  const targets = products.map((product) => product.target.replace(/:dist-package$/, ':dist'))
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
      `Buck dist build failed:\n${build.stderr.toString()}\n${build.stdout.toString()}`,
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
  const violations = products.flatMap((product) => {
    const target = product.target.replace(/:dist-package$/, ':dist')
    const path = output.get(target)
    if (path === undefined) throw new Error(`Buck did not report an output for ${target}`)
    const manifest = JSON.parse(
      readFileSync(join(root, product.packagePath, 'package.json'), 'utf8'),
    ) as PackageManifest
    return runtimeImportViolations(manifest, isAbsolute(path) === true ? path : join(root, path))
  })
  expect(violations).toEqual([])
}, 900_000)
