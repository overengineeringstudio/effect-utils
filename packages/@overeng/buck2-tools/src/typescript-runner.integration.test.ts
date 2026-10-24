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
import { dirname, join } from 'node:path'

import { expect, it } from 'vitest'

import {
  assertNixEmitIsolation,
  copyWritableTree,
  darwinEmitCommand,
  runEmit,
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
    const artifactRoot = join(root, 'buck-out', 'artifacts')
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

it('removes the private emit stage after compiler failure without changing immutable inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'typescript-failed-cleanup-'))
  const packageTree = join(root, 'buck-out', 'package')
  const dependency = join(root, 'dependency')
  const output = join(root, 'output')
  const compiler = join(root, 'tsgo')
  mkdirSync(packageTree, { recursive: true })
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

it('denies every canonical Buck ancestor while retaining declared artifact reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'typescript-profile-'))
  const buckOut = join(root, 'physical', 'buck-out')
  const alias = join(root, 'alias')
  mkdirSync(buckOut, { recursive: true })
  symlinkSync(buckOut, alias)
  try {
    const command = await darwinEmitCommand({ argv: ['/compiler'], buckOut: alias })
    expect(command[0]).toBe('/usr/bin/sandbox-exec')
    const profile = command[2]!
    let ancestor = dirname(realpathSync(buckOut))
    for (;;) {
      expect(profile).toContain(`(subpath ${JSON.stringify(join(ancestor, 'node_modules'))})`)
      for (const name of ['package.json', 'tsconfig.json', 'jsconfig.json'])
        expect(profile).toContain(`(literal ${JSON.stringify(join(ancestor, name))})`)
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
    expect(profile).not.toContain(JSON.stringify(join(realpathSync(buckOut), 'node_modules')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform !== 'darwin')(
  'fails closed when sandbox-exec is missing or rejects its profile',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'typescript-sandbox-failure-'))
    const buckOut = join(root, 'buck-out')
    const receipt = join(root, 'compiler-ran')
    mkdirSync(buckOut)
    try {
      const command = await darwinEmitCommand({
        argv: [process.execPath, '-e', `await Bun.write(${JSON.stringify(receipt)}, 'ran')`],
        buckOut,
      })
      expect(() => Bun.spawn([join(root, 'missing-sandbox-exec'), ...command.slice(1)])).toThrow()
      expect(existsSync(receipt)).toBe(false)
      const invalidProfile = Bun.spawn(
        [command[0]!, '-p', '(invalid profile', ...command.slice(3)],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      expect(await invalidProfile.exited).not.toBe(0)
      expect(existsSync(receipt)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it.each(['.editor-view', '.editor-view-content'])(
  'fails closed outside a clean declared Nix build and rejects reachable %s trees',
  async (editorDirectory) => {
    const root = mkdtempSync(join(tmpdir(), 'typescript-nix-isolation-'))
    const buckOut = join(root, 'source', 'buck-out')
    const input = join(buckOut, 'input')
    const stagingRoot = join(root, 'stage')
    const home = join(root, 'home')
    for (const path of [input, stagingRoot, home]) mkdirSync(path, { recursive: true })
    const options = {
      buckOut,
      readRoots: [input],
      stagingRoot,
      // Treat the process temp directory as the builder's private root. The host
      // may legitimately have unrelated configuration there (outside source).
      environment: { NIX_BUILD_TOP: tmpdir(), HOME: home },
    }
    try {
      await expect(assertNixEmitIsolation(options)).resolves.toBeUndefined()
      await expect(assertNixEmitIsolation({ ...options, environment: {} })).rejects.toThrow(
        'NIX_BUILD_TOP',
      )
      await expect(
        assertNixEmitIsolation({
          ...options,
          environment: { NIX_BUILD_TOP: root, HOME: tmpdir() },
        }),
      ).rejects.toThrow('Nix build HOME')
      await expect(
        assertNixEmitIsolation({
          ...options,
          environment: { NIX_BUILD_TOP: home, HOME: '/homeless-shelter' },
        }),
      ).rejects.toThrow('buck-out inside NIX_BUILD_TOP')
      await expect(assertNixEmitIsolation({ ...options, readRoots: [] })).rejects.toThrow(
        'declared read roots',
      )
      const editor = join(root, editorDirectory, 'types')
      mkdirSync(editor, { recursive: true })
      symlinkSync(editor, join(input, 'ambient-types'))
      await expect(assertNixEmitIsolation(options)).rejects.toThrow('editor view is reachable')
      rmSync(join(input, 'ambient-types'))
      rmSync(join(root, editorDirectory), { recursive: true })
      symlinkSync(input, join(input, 'cycle'))
      await expect(assertNixEmitIsolation(options)).resolves.toBeUndefined()
      symlinkSync('/etc', join(input, 'outside-build'))
      await expect(assertNixEmitIsolation(options)).rejects.toThrow(
        'escapes the build and store roots',
      )
      rmSync(join(input, 'outside-build'))
      symlinkSync(input, join(root, 'source', 'node_modules'))
      await expect(assertNixEmitIsolation(options)).rejects.toThrow(
        'ancestor contains editor lookup',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it.skipIf(process.platform !== 'darwin')(
  'enforces the default Darwin sandbox read denial',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'typescript-default-sandbox-'))
    const buckOut = join(root, 'buck-out')
    const editor = join(root, '.editor-view')
    mkdirSync(buckOut)
    mkdirSync(editor)
    writeFileSync(join(editor, 'ambient.d.ts'), 'declare const editorAmbient: true')
    symlinkSync(editor, join(root, 'node_modules'))
    try {
      const command = await darwinEmitCommand({
        buckOut,
        argv: ['/bin/cat', join(root, 'node_modules', 'ambient.d.ts')],
      })
      expect(command[0]).toBe('/usr/bin/sandbox-exec')
      const child = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe' })
      expect(await child.exited).not.toBe(0)
      expect(await new Response(child.stdout).text()).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
