import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runPackageTreeCli } from './package-tree.ts'

const scratchDirectories: string[] = []
type AssemblyFixture = {
  readonly root: string
  readonly nodeModules: string
  readonly packageDirectory: string
  readonly output: string
}

const createAssemblyFixture = (): AssemblyFixture => {
  const root = mkdtempSync(join(tmpdir(), 'package-tree-'))
  scratchDirectories.push(root)
  const nodeModules = join(root, 'source', 'node_modules')
  const packageDirectory = join(nodeModules, '.pnpm', 'safe', 'node_modules', 'safe')
  const output = join(root, 'output')
  mkdirSync(packageDirectory, { recursive: true })
  writeFileSync(join(packageDirectory, 'package.json'), '{"name":"safe"}\n')
  return { root, nodeModules, packageDirectory, output }
}

const assemble = ({ nodeModules, output }: AssemblyFixture): void =>
  runPackageTreeCli(['--output', output, '--node-modules', nodeModules])

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true })
})

describe('Buck package-tree symlink containment', () => {
  it('retains a safe relative symlink whose destination is inside the assembled tree', () => {
    const fixture = createAssemblyFixture()
    symlinkSync('.pnpm/safe/node_modules/safe', join(fixture.nodeModules, 'safe'))

    assemble(fixture)

    expect(readlinkSync(join(fixture.output, 'node_modules', 'safe'))).toBe(
      '.pnpm/safe/node_modules/safe',
    )
  })

  it('does not alias regular source files into the mutable Buck output tree', () => {
    const fixture = createAssemblyFixture()
    const source = join(fixture.packageDirectory, 'package.json')
    chmodSync(source, 0o444)

    assemble(fixture)

    const output = join(
      fixture.output,
      'node_modules',
      '.pnpm',
      'safe',
      'node_modules',
      'safe',
      'package.json',
    )
    expect(statSync(output).ino).not.toBe(statSync(source).ino)
    chmodSync(output, 0o644)
    expect(statSync(source).mode & 0o777).toBe(0o444)
  })

  it('rejects an existing absolute target and removes the incomplete package tree', () => {
    const fixture = createAssemblyFixture()
    symlinkSync(fixture.packageDirectory, join(fixture.nodeModules, 'absolute-target'))

    expect(() => assemble(fixture)).toThrow('absolute target')
    expect(existsSync(fixture.output)).toBe(false)
  })

  it('rejects a relative target that escapes the assembled tree', () => {
    const fixture = createAssemblyFixture()
    writeFileSync(join(fixture.root, 'outside.txt'), 'outside\n')
    symlinkSync('../../outside.txt', join(fixture.nodeModules, 'relative-escape'))

    expect(() => assemble(fixture)).toThrow('target escapes tree')
    expect(existsSync(fixture.output)).toBe(false)
  })

  it('rejects a dangling relative target', () => {
    const fixture = createAssemblyFixture()
    symlinkSync('missing', join(fixture.nodeModules, 'dangling'))

    expect(() => assemble(fixture)).toThrow('target is dangling')
    expect(existsSync(fixture.output)).toBe(false)
  })

  it('rejects a contained relative link whose chained target escapes the assembled tree', () => {
    const fixture = createAssemblyFixture()
    writeFileSync(join(fixture.root, 'outside.txt'), 'outside\n')
    symlinkSync('../../outside.txt', join(fixture.nodeModules, 'redirect'))
    symlinkSync('redirect', join(fixture.nodeModules, 'chained-escape'))

    expect(() => assemble(fixture)).toThrow('chained target resolves outside tree')
    expect(existsSync(fixture.output)).toBe(false)
  })
})
