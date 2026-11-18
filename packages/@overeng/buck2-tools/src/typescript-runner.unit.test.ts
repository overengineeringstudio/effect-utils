import { EventEmitter } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  lstatSync,
  rmSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  copyDeclarationSources,
  formatError,
  type FingerprintChild,
  hashDeclaredInputRoots,
  linkStagedWorkspaceProjects,
  parseEmitOptions as parseEmit,
  parseTypecheckOptions as parseTypecheck,
  relinkStagedDependencyView,
  runFingerprintTool,
  stagedEmitPackageRoot,
} from './typescript-runner.ts'

const scratchDirectories: string[] = []
const fingerprintTool =
  '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-buck2-fingerprint/bin/buck2-fingerprint'
const parseEmitOptions = (args: readonly string[]) =>
  parseEmit([...args, '--fingerprint-tool', fingerprintTool])
const parseTypecheckOptions = (args: readonly string[]) =>
  parseTypecheck([...args, '--fingerprint-tool', fingerprintTool])

const createFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'typescript-runner-'))
  scratchDirectories.push(root)
  const packageRoot = join(root, 'package')
  const output = join(root, 'output')
  mkdirSync(join(packageRoot, 'src'), { recursive: true })
  mkdirSync(output)
  return { root, packageRoot, output }
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true })
})

it('preserves an error message when the runtime stack omits it', () => {
  const error = new Error('expected declaration entrypoint was not emitted: mod.d.ts')
  error.stack = 'Error\n    at validateOutput (typescript-runner.ts:471:7)'

  expect(formatError(error)).toContain(
    'expected declaration entrypoint was not emitted: mod.d.ts\nError',
  )
})

it('requires an explicit declared argument to select Nix Darwin isolation', () => {
  const args = [
    '/nix/store/toolchain/bin/tsgo',
    '/package-tree',
    'tsconfig.json',
    'dist',
    '',
    '/output',
  ]
  expect(parseEmitOptions(args).darwinIsolation).toBe('sandbox-exec')
  expect(
    parseEmitOptions([...args, '--darwin-isolation', 'nix-build-sandbox']).darwinIsolation,
  ).toBe('nix-build-sandbox')
  expect(() => parseEmitOptions([...args, '--darwin-isolation', 'auto'])).toThrow(
    'unknown Darwin emit isolation mode',
  )
  expect(() =>
    parseTypecheckOptions([
      '/nix/store/toolchain/bin/tsgo',
      '/package-tree',
      'tsconfig.json',
      '/output',
      '--darwin-isolation',
      'nix-build-sandbox',
    ]),
  ).toThrow('unexpected typecheck argument')
})

type FingerprintTestChild = EventEmitter & FingerprintChild

it('bounds root subprocesses to four and continues after a failed fingerprint', async () => {
  // Only streams and lifecycle events belong to this test; no OS child is started.
  const makeChild = (): FingerprintTestChild =>
    Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  const turns = Array.from({ length: 9 }, () => Promise.withResolvers<FingerprintTestChild>())
  let spawned = 0
  const spawnChild = vi.fn(() => {
    const child = makeChild()
    turns[spawned]?.resolve(child)
    spawned += 1
    return child
  })
  const results = Promise.allSettled(
    turns.map((_, index) =>
      runFingerprintTool({ tool: fingerprintTool, args: [`/root-${index}`], spawnChild }),
    ),
  )
  for (const [index, turn] of turns.entries()) {
    const child = await turn.promise
    expect(spawned).toBeLessThanOrEqual(Math.min(index + 4, turns.length))
    child.emit('close', index === 0 ? 1 : 0, null)
  }
  const settled = await results
  expect(settled.map((result) => result.status)).toEqual([
    'rejected',
    ...Array.from({ length: 8 }, () => 'fulfilled'),
  ])
})

it('does not admit queued or new fingerprint children after cancellation', async () => {
  const cancellation = new AbortController()
  const children: FingerprintTestChild[] = []
  const spawnChild = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    })
    children.push(child)
    return child
  })
  const settled = Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      runFingerprintTool({
        tool: fingerprintTool,
        args: [`/cancel-${index}`],
        spawnChild,
        signal: cancellation.signal,
      }),
    ),
  )
  await Promise.resolve()
  expect(children).toHaveLength(4)
  cancellation.abort()
  for (const child of children) child.emit('close', 1, 'SIGTERM')
  expect((await settled).every((result) => result.status === 'rejected')).toBe(true)
  await expect(
    runFingerprintTool({
      tool: fingerprintTool,
      args: ['/cancel-new'],
      spawnChild,
      signal: cancellation.signal,
    }),
  ).rejects.toThrow('admission closed')
  expect(spawnChild).toHaveBeenCalledTimes(4)
})

it('memoizes immutable roots only for identical fingerprint semantics', async () => {
  const spawnChild = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    })
    queueMicrotask(() => {
      child.stdout.write('digest immutable\n')
      child.emit('close', 0, null)
    })
    return child
  })
  const args = ['/nix/store/test-immutable-fingerprint/root']
  const first = runFingerprintTool({ tool: fingerprintTool, args, spawnChild })
  const duplicate = runFingerprintTool({ tool: fingerprintTool, args, spawnChild })
  expect(duplicate).toBe(first)
  await first
  await runFingerprintTool({ tool: fingerprintTool, args: [...args, '--dereference'], spawnChild })
  expect(spawnChild).toHaveBeenCalledTimes(2)
  await runFingerprintTool({ tool: fingerprintTool, args: ['/mutable/root'], spawnChild })
  await runFingerprintTool({ tool: fingerprintTool, args: ['/mutable/root'], spawnChild })
  expect(spawnChild).toHaveBeenCalledTimes(4)
})

describe('TypeScript emit declaration command', () => {
  it('parses explicit normalized declaration paths', () => {
    const options = parseEmitOptions([
      '/nix/store/toolchain/bin/tsgo',
      '/package-tree',
      'tsconfig.json',
      'dist',
      'src/mod.d.ts',
      '/output',
      '--copy-declaration',
      'src/vite-types.d.ts',
      '--read-root',
      '/dependency-view',
    ])

    expect(options.declarationSources).toEqual(['src/vite-types.d.ts'])
    expect(options.fingerprintTool).toBe(fingerprintTool)
  })

  it('parses canonical repeatable declared read roots', () => {
    expect(
      parseTypecheckOptions([
        '/nix/store/toolchain/bin/tsgo',
        '/package-tree',
        'tsconfig.json',
        '/output',
        '--read-root',
        '/z-dependency',
        '--read-root',
        '/a-dependency',
        '--read-root',
        '/z-dependency',
      ]).readRoots,
    ).toEqual(['/a-dependency', '/z-dependency'])
  })

  it('hashes every canonical declared input root and does not follow symlink cycles', async () => {
    const { root } = createFixture()
    const first = join(root, 'first')
    const second = join(root, 'second')
    mkdirSync(first)
    mkdirSync(second)
    writeFileSync(join(first, 'source.ts'), 'export const value = 1\n')
    writeFileSync(join(second, 'dependency.d.ts'), 'export declare const dependency: 1\n')
    symlinkSync(first, join(second, 'cycle'))

    const tool = process.env['FINGERPRINT_BIN'] ?? ''
    if (tool === '') throw new Error('declared test tool is unavailable: FINGERPRINT_BIN')
    const before = await hashDeclaredInputRoots({
      roots: [second, first, second],
      fingerprintTool: tool,
    })
    writeFileSync(join(second, 'dependency.d.ts'), 'export declare const dependency: 2\n')
    const after = await hashDeclaredInputRoots({ roots: [first, second], fingerprintTool: tool })

    expect(after).not.toBe(before)
    const file = join(first, 'source.ts')
    const beforeMode = await hashDeclaredInputRoots({ roots: [file], fingerprintTool: tool })
    chmodSync(file, 0o755)
    const afterMode = await hashDeclaredInputRoots({ roots: [file], fingerprintTool: tool })
    expect(afterMode).not.toBe(beforeMode)
  })

  it('rejects missing or mutable fingerprint executables', () => {
    const args = ['/nix/store/toolchain/bin/tsgo', '/package-tree', 'tsconfig.json', '/output']
    expect(() => parseTypecheck(args)).toThrow('missing --fingerprint-tool')
    expect(() => parseTypecheck([...args, '--fingerprint-tool', '/tmp/buck2-fingerprint'])).toThrow(
      'immutable /nix/store executable',
    )
  })

  it.each(['../outside.d.ts', '/outside.d.ts', 'src\\outside.d.ts', 'src//outside.d.ts'])(
    'rejects unsafe declaration path %s',
    (declarationPath) => {
      expect(() =>
        parseEmitOptions([
          '/nix/store/toolchain/bin/tsgo',
          '/package-tree',
          'tsconfig.json',
          'dist',
          'src/mod.d.ts',
          '/output',
          '--copy-declaration',
          declarationPath,
        ]),
      ).toThrow('declaration source must be a normalized portable relative path')
    },
  )
})

it('rebinds a staged package to its declared dependency view after relocation', async () => {
  const { root, packageRoot } = createFixture()
  const dependencyView = join(root, 'buck-artifact', 'node_modules')
  const stagedPackageRoot = join(root, 'system-temp', 'package')
  mkdirSync(dependencyView, { recursive: true })
  mkdirSync(stagedPackageRoot, { recursive: true })
  symlinkSync('../buck-artifact/node_modules', join(packageRoot, 'node_modules'))
  symlinkSync('../buck-artifact/node_modules', join(stagedPackageRoot, 'node_modules'))

  await relinkStagedDependencyView({ packageTree: packageRoot, stagedPackageRoot })

  expect(readlinkSync(join(stagedPackageRoot, 'node_modules'))).toBe(realpathSync(dependencyView))
  expect(lstatSync(join(stagedPackageRoot, 'node_modules')).isSymbolicLink()).toBe(true)
})

it('rebinds projected dependency entries after package relocation', async () => {
  const { root, packageRoot } = createFixture()
  const dependencyPackage = join(root, 'buck-artifact', 'dependency')
  const sourceLink = join(packageRoot, 'node_modules', '@overeng', 'dependency')
  const stagedPackageRoot = join(root, 'system-temp', 'package')
  const stagedLink = join(stagedPackageRoot, 'node_modules', '@overeng', 'dependency')
  mkdirSync(dependencyPackage, { recursive: true })
  writeFileSync(join(dependencyPackage, 'package.json'), '{"name":"dependency"}\n')
  mkdirSync(dirname(sourceLink), { recursive: true })
  mkdirSync(dirname(stagedLink), { recursive: true })
  const sourceTarget = relative(dirname(sourceLink), dependencyPackage)
  symlinkSync(sourceTarget, sourceLink)
  symlinkSync(sourceTarget, stagedLink)

  await relinkStagedDependencyView({ packageTree: packageRoot, stagedPackageRoot })

  expect(readlinkSync(stagedLink)).toBe(realpathSync(dependencyPackage))
  expect(statSync(stagedLink).isDirectory()).toBe(true)
})

it('projects declared workspace package trees beside the relocated package', async () => {
  const { root } = createFixture()
  const artifactRoot = join(root, 'buck-out', 'packages', '@overeng')
  const packageTree = join(artifactRoot, 'notion-cli', '__package_tree__', 'package_tree')
  const siblingTree = join(artifactRoot, 'effect-path', '__package_tree__', 'package_tree')
  const stagingRoot = join(root, 'system-temp')
  const stagedPackageRoot = join(stagingRoot, 'package')
  mkdirSync(packageTree, { recursive: true })
  mkdirSync(join(siblingTree, 'node_modules'), { recursive: true })
  writeFileSync(
    join(siblingTree, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { composite: true, noEmit: true } }, undefined, 2)}\n`,
  )
  mkdirSync(stagedPackageRoot, { recursive: true })

  await linkStagedWorkspaceProjects({
    packageTree,
    readRoots: [packageTree, siblingTree],
    stagedPackageRoot,
    stagingRoot,
  })

  const stagedSibling = join(stagingRoot, 'effect-path')
  expect(lstatSync(stagedSibling).isDirectory()).toBe(true)
  expect(JSON.parse(readFileSync(join(stagedSibling, 'tsconfig.json'), 'utf8'))).toEqual({
    compilerOptions: { composite: true, noEmit: false },
  })
})

it('stages a nested example and its declared siblings without escaping the scratch root', async () => {
  const { root } = createFixture()
  const artifactRoot = join(root, 'buck-out', 'packages', '@overeng')
  const packageTree = join(
    artifactRoot,
    'effect-rpc-tanstack',
    'examples',
    'basic',
    '__package_tree__',
    'package_tree',
  )
  const siblingTree = join(artifactRoot, 'content-address', '__package_tree__', 'package_tree')
  const stagingRoot = join(root, 'system-temp')
  mkdirSync(join(siblingTree, 'node_modules'), { recursive: true })
  mkdirSync(packageTree, { recursive: true })
  writeFileSync(join(siblingTree, 'package.json'), '{"name":"@overeng/content-address"}\n')
  const stagedPackageRoot = stagedEmitPackageRoot({
    packageTree,
    readRoots: [packageTree, siblingTree],
    stagingRoot,
  })
  mkdirSync(stagedPackageRoot, { recursive: true })

  await linkStagedWorkspaceProjects({
    packageTree,
    readRoots: [packageTree, siblingTree],
    stagedPackageRoot,
    stagingRoot,
  })

  expect(
    readFileSync(join(stagingRoot, 'workspace', 'content-address', 'package.json'), 'utf8'),
  ).toContain('@overeng/content-address')
})

describe('TypeScript handwritten declaration copy', () => {
  it('copies only explicit files while preserving their package-relative paths', async () => {
    const fixture = createFixture()
    writeFileSync(join(fixture.packageRoot, 'src', 'vite-types.d.ts'), 'export type Vite = true\n')
    writeFileSync(join(fixture.packageRoot, 'src', 'ambient.d.ts'), 'declare const ambient: true\n')

    await copyDeclarationSources({
      declarationSources: ['src/vite-types.d.ts'],
      output: fixture.output,
      packageRoot: fixture.packageRoot,
    })

    expect(readFileSync(join(fixture.output, 'src', 'vite-types.d.ts'), 'utf8')).toBe(
      'export type Vite = true\n',
    )
    expect(existsSync(join(fixture.output, 'src', 'ambient.d.ts'))).toBe(false)
  })

  it('rejects missing, directory, and symlink inputs', async () => {
    const fixture = createFixture()
    mkdirSync(join(fixture.packageRoot, 'src', 'directory.d.ts'))
    writeFileSync(join(fixture.root, 'outside.d.ts'), 'export type Outside = true\n')
    symlinkSync(join(fixture.root, 'outside.d.ts'), join(fixture.packageRoot, 'src', 'link.d.ts'))

    await expect(
      copyDeclarationSources({
        declarationSources: ['src/missing.d.ts'],
        output: fixture.output,
        packageRoot: fixture.packageRoot,
      }),
    ).rejects.toThrow('declaration source does not exist: src/missing.d.ts')
    await expect(
      copyDeclarationSources({
        declarationSources: ['src/directory.d.ts'],
        output: fixture.output,
        packageRoot: fixture.packageRoot,
      }),
    ).rejects.toThrow('declaration source is not a regular file: src/directory.d.ts')
    await expect(
      copyDeclarationSources({
        declarationSources: ['src/link.d.ts'],
        output: fixture.output,
        packageRoot: fixture.packageRoot,
      }),
    ).rejects.toThrow('declaration source is not a regular file: src/link.d.ts')
  })
})
