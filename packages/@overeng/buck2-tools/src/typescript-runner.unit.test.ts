import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { copyDeclarationSources, parseEmitOptions } from './typescript-runner.ts'

const scratchDirectories: string[] = []

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
    ])

    expect(options.declarationSources).toEqual(['src/vite-types.d.ts'])
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
