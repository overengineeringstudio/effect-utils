import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { copyWritableTree, runEmit } from './typescript-runner.ts'

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
    if (preExistingOutput === true) {
      mkdirSync(abandoned, { recursive: true })
      writeFileSync(join(abandoned, 'old.d.ts'), 'stale declaration\n')
      chmodSync(join(abandoned, 'old.d.ts'), 0o444)
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
