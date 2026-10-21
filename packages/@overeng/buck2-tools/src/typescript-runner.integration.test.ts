import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { expect, it } from 'vitest'

import {
  assertCleanEmitAncestors,
  copyWritableTree,
  runEmit,
  stageDeclaredEmitInputs,
} from './typescript-runner.ts'

it('creates removable scratch copies of immutable inputs without following symlinks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'typescript-scratch-copy-'))
  const source = join(root, 'source')
  const destination = join(root, 'scratch')
  const external = join(root, 'external')
  mkdirSync(join(source, 'src'), { recursive: true })
  mkdirSync(external)
  writeFileSync(join(source, 'src', 'mod.ts'), 'export const value = 1\n')
  writeFileSync(join(external, 'keep'), 'immutable dependency\n')
  symlinkSync(external, join(source, 'dependency'))
  for (const path of [source, join(source, 'src'), external]) chmodSync(path, 0o555)
  chmodSync(join(source, 'src', 'mod.ts'), 0o444)
  chmodSync(join(external, 'keep'), 0o444)
  try {
    await copyWritableTree({ source, destination })
    expect(statSync(destination).mode & 0o200).toBe(0o200)
    expect(statSync(join(destination, 'src')).mode & 0o200).toBe(0o200)
    expect(statSync(join(destination, 'src', 'mod.ts')).mode & 0o200).toBe(0o200)
    expect(statSync(external).mode & 0o777).toBe(0o555)
    expect(statSync(join(external, 'keep')).mode & 0o777).toBe(0o444)
    // Buck can remove an abandoned action tree without runner cleanup or chmod.
    rmSync(destination, { recursive: true })
    expect(existsSync(destination)).toBe(false)
    expect(readFileSync(join(external, 'keep'), 'utf8')).toBe('immutable dependency\n')
  } finally {
    for (const path of [source, join(source, 'src'), external]) chmodSync(path, 0o755)
    rmSync(root, { recursive: true, force: true })
  }
})

it.each([
  { mutation: 'unchanged', preExistingOutput: false },
  { mutation: 'unchanged', preExistingOutput: true },
  { mutation: 'package', preExistingOutput: true },
  { mutation: 'sibling', preExistingOutput: true },
] as const)(
  'preserves output lifecycle and input fingerprints: $mutation (pre-existing root: $preExistingOutput)',
  async ({ mutation, preExistingOutput }) => {
    const root = mkdtempSync(join(tmpdir(), 'typescript-emit-invariant-'))
    const artifactRoot = join(root, 'artifacts')
    const packageTree = join(artifactRoot, 'owner', '__package_tree__', 'package_tree')
    const siblingTree = join(artifactRoot, 'sibling', '__package_tree__', 'package_tree')
    const output = join(root, 'output')
    const compiler = join(root, 'tsgo')
    for (const tree of [packageTree, siblingTree]) {
      mkdirSync(join(tree, 'src'), { recursive: true })
      mkdirSync(join(tree, 'node_modules'))
      writeFileSync(join(tree, 'src', 'mod.ts'), 'export const value = 1\n')
      writeFileSync(join(tree, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true}}\n')
    }
    const abandoned = join(output, '.abandoned')
    const retained = join(root, 'retained.d.ts')
    const retainedExecutable = join(root, 'retained-executable')
    writeFileSync(retained, 'stale declaration\n')
    writeFileSync(retainedExecutable, '#!/bin/sh\n')
    chmodSync(retained, 0o444)
    chmodSync(retainedExecutable, 0o555)
    const retainedMode = statSync(retained).mode
    const executableMode = statSync(retainedExecutable).mode
    if (preExistingOutput === true) {
      mkdirSync(abandoned, { recursive: true })
      linkSync(retained, join(abandoned, 'old.d.ts'))
      linkSync(retainedExecutable, join(output, 'old-executable'))
      symlinkSync(retained, join(output, 'retained-link'))
      symlinkSync(packageTree, join(output, 'dependency'))
      symlinkSync('missing', join(output, 'dangling'))
      chmodSync(abandoned, 0o555)
      chmodSync(output, 0o555)
    }
    const outputInode = preExistingOutput === true ? statSync(output).ino : undefined
    const packageMode = statSync(packageTree).mode
    // A real child executable deliberately violates the compiler's input contract.
    writeFileSync(
      compiler,
      `#!${process.execPath}\n` +
        `import { readFileSync, writeFileSync } from 'node:fs';\n` +
        `import { join } from 'node:path';\n` +
        `const out = process.argv[process.argv.indexOf('--outDir') + 1];\n` +
        `const mutation = ${JSON.stringify(mutation)};\n` +
        `const source = mutation === 'sibling' ? join(process.cwd(), '../sibling/src/mod.ts') : join(process.cwd(), 'src/mod.ts');\n` +
        `if (mutation !== 'unchanged') writeFileSync(source, 'export const value = 2\\n');\n` +
        `writeFileSync(join(out, 'mutation.txt'), readFileSync(source));\n` +
        `writeFileSync(join(out, 'mod.d.ts'), 'export declare const value: number\\n');\n`,
    )
    chmodSync(compiler, 0o755)
    const fingerprintTool = process.env['FINGERPRINT_BIN'] ?? ''
    if (fingerprintTool === '')
      throw new Error('declared test tool is unavailable: FINGERPRINT_BIN')
    try {
      const status = await runEmit({
        declarationEntrypoint: 'mod.d.ts',
        declarationSources: [],
        outDir: 'dist',
        output,
        packageTree,
        fingerprintTool,
        readRoots: [siblingTree],
        project: 'tsconfig.json',
        tsgo: compiler,
      })
      expect(readFileSync(join(output, 'mutation.txt'), 'utf8')).toBe(
        `export const value = ${mutation === 'unchanged' ? 1 : 2}\n`,
      )
      expect(status).toBe(mutation === 'unchanged' ? 0 : 1)
      if (preExistingOutput === true) expect(statSync(output).ino).toBe(outputInode)
      expect(readdirSync(output).toSorted()).toEqual(['mod.d.ts', 'mutation.txt'])
      expect(statSync(packageTree).mode).toBe(packageMode)
      // Output cleanup must unlink aliases without chmodding their retained inodes.
      expect(statSync(retained).mode).toBe(retainedMode)
      expect(statSync(retainedExecutable).mode).toBe(executableMode)
      for (const tree of [packageTree, siblingTree])
        expect(readFileSync(join(tree, 'src', 'mod.ts'), 'utf8')).toBe('export const value = 1\n')
    } finally {
      // Restore permissions even when an assertion fails before the runner prepares output.
      if (existsSync(output) === true) chmodSync(output, 0o755)
      if (existsSync(abandoned) === true) chmodSync(abandoned, 0o755)
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it.each(['node_modules', 'package.json', 'tsconfig.json'])(
  'refuses a contaminated emit staging ancestor: %s',
  async (name) => {
    const temporaryDirectory = process.platform === 'darwin' ? '/private/tmp' : '/tmp'
    const root = mkdtempSync(join(temporaryDirectory, 'typescript-ambient-'))
    const stagingRoot = join(root, 'scratch', 'emit')
    mkdirSync(stagingRoot, { recursive: true })
    try {
      await expect(assertCleanEmitAncestors(stagingRoot)).resolves.toBeUndefined()
      if (name === 'node_modules') mkdirSync(join(root, name))
      else writeFileSync(join(root, name), '{}\n')
      await expect(assertCleanEmitAncestors(stagingRoot)).rejects.toThrow(
        `undeclared resolution ancestor: ${join(realpathSync(root), name)}`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it.each(['whole-view', 'projected-entries'])(
  'stages the complete %s dependency closure without links back to Buck artifacts',
  async (shape) => {
    const root = mkdtempSync(join(tmpdir(), 'typescript-closure-'))
    const packageTree = join(root, 'buck-out', 'owner', '__package_tree__', 'package_tree')
    const dependency = join(root, 'buck-out', 'dependency', 'node_modules', 'dependency')
    const view = join(root, 'buck-out', 'view', 'node_modules')
    const stagingRoot = join(root, 'scratch')
    mkdirSync(packageTree, { recursive: true })
    mkdirSync(dependency, { recursive: true })
    mkdirSync(view, { recursive: true })
    writeFileSync(join(dependency, 'package.json'), '{"name":"dependency"}\n')
    const viewLink = join(view, 'dependency')
    symlinkSync(relative(dirname(viewLink), dependency), viewLink)
    if (shape === 'whole-view') symlinkSync(view, join(packageTree, 'node_modules'))
    else {
      mkdirSync(join(packageTree, 'node_modules'))
      symlinkSync(dependency, join(packageTree, 'node_modules', 'dependency'))
    }
    try {
      const packageRoot = await stageDeclaredEmitInputs({
        packageTree,
        readRoots: [packageTree, view, dirname(dirname(dependency))],
        stagingRoot,
      })
      const stagedDependency = realpathSync(join(packageRoot, 'node_modules', 'dependency'))
      expect(relative(stagingRoot, stagedDependency).startsWith('..')).toBe(false)
      expect(stagedDependency).not.toBe(realpathSync(dependency))
      expect(readFileSync(join(stagedDependency, 'package.json'), 'utf8')).toContain('dependency')
      // CoW copies must not share a mutable inode or chmod state with the input.
      writeFileSync(join(stagedDependency, 'package.json'), '{}\n')
      expect(readFileSync(join(dependency, 'package.json'), 'utf8')).toContain('dependency')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it('rejects an emit dependency link outside the declared closure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'typescript-undeclared-'))
  const packageTree = join(root, 'package')
  const undeclared = join(root, 'undeclared')
  mkdirSync(packageTree)
  mkdirSync(undeclared)
  symlinkSync(undeclared, join(packageTree, 'node_modules'))
  try {
    await expect(
      stageDeclaredEmitInputs({
        packageTree,
        readRoots: [packageTree],
        stagingRoot: join(root, 'scratch'),
      }),
    ).rejects.toThrow('emit dependency link escapes declared read roots')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('stages nested workspace references and enables sibling emit without modifying inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'typescript-workspace-'))
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
  const stagingRoot = join(root, 'scratch')
  mkdirSync(packageTree, { recursive: true })
  mkdirSync(siblingTree, { recursive: true })
  const config = '{"compilerOptions":{"composite":true,"noEmit":true}}\n'
  writeFileSync(join(siblingTree, 'tsconfig.json'), config)
  try {
    await stageDeclaredEmitInputs({
      packageTree,
      readRoots: [packageTree, siblingTree],
      stagingRoot,
    })
    const stagedSibling = join(stagingRoot, 'workspace', 'content-address')
    expect(JSON.parse(readFileSync(join(stagedSibling, 'tsconfig.json'), 'utf8'))).toEqual({
      compilerOptions: { composite: true, noEmit: false },
    })
    expect(readFileSync(join(siblingTree, 'tsconfig.json'), 'utf8')).toBe(config)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('removes the private emit stage after compiler failure without changing immutable inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'typescript-failed-cleanup-'))
  const packageTree = join(root, 'package')
  const dependency = join(root, 'dependency')
  const output = join(root, 'output')
  const compiler = join(root, 'tsgo')
  mkdirSync(packageTree)
  mkdirSync(join(dependency, 'nested'), { recursive: true })
  writeFileSync(join(dependency, 'nested', 'index.d.ts'), 'export type Value = true\n')
  symlinkSync(dependency, join(packageTree, 'node_modules'))
  writeFileSync(join(packageTree, 'tsconfig.json'), '{}\n')
  writeFileSync(
    compiler,
    `#!${process.execPath}\n` +
      `import { statSync, writeFileSync } from 'node:fs';\n` +
      `import { dirname, join } from 'node:path';\n` +
      `const stage = dirname(process.cwd());\n` +
      `const output = process.argv[process.argv.indexOf('--outDir') + 1];\n` +
      `writeFileSync(join(output, 'stage.json'), JSON.stringify({ stage, mode: statSync(stage).mode & 0o777 }));\n` +
      `process.exit(17);\n`,
  )
  chmodSync(compiler, 0o755)
  chmodSync(join(dependency, 'nested', 'index.d.ts'), 0o444)
  chmodSync(join(dependency, 'nested'), 0o555)
  chmodSync(dependency, 0o555)
  const fingerprintTool = process.env['FINGERPRINT_BIN'] ?? ''
  if (fingerprintTool === '') throw new Error('declared test tool is unavailable: FINGERPRINT_BIN')
  try {
    const status = await runEmit({
      declarationEntrypoint: undefined,
      declarationSources: [],
      outDir: 'dist',
      output,
      packageTree,
      fingerprintTool,
      readRoots: [dependency],
      project: 'tsconfig.json',
      tsgo: compiler,
    })
    const receipt = JSON.parse(readFileSync(join(output, 'stage.json'), 'utf8')) as {
      stage: string
      mode: number
    }
    expect(status).toBe(17)
    expect(receipt.mode).toBe(0o700)
    expect(existsSync(receipt.stage)).toBe(false)
    expect(statSync(dependency).mode & 0o777).toBe(0o555)
    expect(statSync(join(dependency, 'nested', 'index.d.ts')).mode & 0o777).toBe(0o444)
  } finally {
    chmodSync(dependency, 0o755)
    chmodSync(join(dependency, 'nested'), 0o755)
    rmSync(root, { recursive: true, force: true })
  }
})
