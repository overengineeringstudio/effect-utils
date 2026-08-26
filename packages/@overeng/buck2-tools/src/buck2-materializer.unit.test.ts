import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runBuck2MaterializerCli } from './buck2-materializer.ts'

const scratchDirectories: string[] = []

const createAssemblyFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'buck2-materializer-'))
  scratchDirectories.push(root)
  const nodeModules = join(root, 'source', 'node_modules')
  const packageDirectory = join(nodeModules, '.pnpm', 'safe', 'node_modules', 'safe')
  const output = join(root, 'output')
  mkdirSync(packageDirectory, { recursive: true })
  writeFileSync(join(packageDirectory, 'package.json'), '{"name":"safe"}\n')
  return { root, nodeModules, packageDirectory, output }
}

const assemble = ({ nodeModules, output }: ReturnType<typeof createAssemblyFixture>) =>
  runBuck2MaterializerCli([
    'assemble-package-tree',
    '--output',
    output,
    '--node-modules',
    nodeModules,
  ])

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true })
})

describe('Buck package-tree materializer symlink containment', () => {
  it('retains a safe relative symlink whose destination is inside the assembled tree', async () => {
    const fixture = createAssemblyFixture()
    symlinkSync('.pnpm/safe/node_modules/safe', join(fixture.nodeModules, 'safe'))

    await assemble(fixture)

    expect(readlinkSync(join(fixture.output, 'node_modules', 'safe'))).toBe(
      '.pnpm/safe/node_modules/safe',
    )
  })

  it('rejects an existing absolute target and removes the incomplete package tree', async () => {
    const fixture = createAssemblyFixture()
    symlinkSync(fixture.packageDirectory, join(fixture.nodeModules, 'absolute-target'))

    await expect(assemble(fixture)).rejects.toThrow('absolute target')
    expect(existsSync(fixture.output)).toBe(false)
  })

  it('rejects a relative target that escapes the assembled tree', async () => {
    const fixture = createAssemblyFixture()
    writeFileSync(join(fixture.root, 'outside.txt'), 'outside\n')
    symlinkSync('../../outside.txt', join(fixture.nodeModules, 'relative-escape'))

    await expect(assemble(fixture)).rejects.toThrow('target escapes tree')
    expect(existsSync(fixture.output)).toBe(false)
  })

  it('rejects a dangling relative target', async () => {
    const fixture = createAssemblyFixture()
    symlinkSync('missing', join(fixture.nodeModules, 'dangling'))

    await expect(assemble(fixture)).rejects.toThrow('target is dangling')
    expect(existsSync(fixture.output)).toBe(false)
  })

  it('rejects a contained relative link whose chained target escapes the assembled tree', async () => {
    const fixture = createAssemblyFixture()
    writeFileSync(join(fixture.root, 'outside.txt'), 'outside\n')
    symlinkSync('../../outside.txt', join(fixture.nodeModules, 'redirect'))
    symlinkSync('redirect', join(fixture.nodeModules, 'chained-escape'))

    await expect(assemble(fixture)).rejects.toThrow('chained target resolves outside tree')
    expect(existsSync(fixture.output)).toBe(false)
  })
})
