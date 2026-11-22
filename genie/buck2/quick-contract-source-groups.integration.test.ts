import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { expect, it } from 'vitest'

import {
  contractSourceGroup,
  contractSourceOwners,
  discoverContractPackages,
  renderContractSourceExclusions,
} from './quick-contract-source-groups.ts'

it('keeps live selectors stable across new files while discovering nested, hidden, and empty owners', () => {
  const temporary = path.resolve('tmp/quick-contract-source-groups')
  mkdirSync(temporary, { recursive: true })
  const root = mkdtempSync(path.join(temporary, 'case-'))
  const put = (file: string): void => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), '')
  }
  try {
    for (const file of [
      'BUCK',
      'src/BUCK.genie.ts',
      'src/nested/BUCK',
      'src/empty/BUCK',
      'src/.config/.nested/old.nix',
      'src/node_modules/ignored/BUCK',
      'src/target/ignored/BUCK',
      'src/.devenv/ignored/BUCK',
    ])
      put(file)
    const before = discoverContractPackages(root)
    expect(before.owners).toEqual(['.', 'src', 'src/empty', 'src/nested'])
    expect(before.directories).toContain('src/.config/.nested')
    expect(before.directories).not.toContain('src/node_modules')
    expect(before.directories).not.toContain('src/target')
    expect(before.directories).not.toContain('src/.devenv')
    const selection = {
      paths: ['src/missing.unit.test.ts'],
      prefixes: ['src/'],
      extensions: ['.ts', '.nix'],
    }
    const selected = contractSourceOwners(selection, before.owners, before.directories)
    expect(selected).toContain('src/empty')
    const source = contractSourceGroup({ selection, owner: 'src', ...before })
    const otherSelection = { paths: [], prefixes: ['other/'] }
    const unaffected = contractSourceGroup({ selection: otherSelection, owner: '.', ...before })
    put('src/new.nix')
    put('src/nested/new.nix')
    put('src/.config/.nested/new.nix')
    put('src/target/new.nix')
    const after = discoverContractPackages(root)
    expect(after).toEqual(before)
    expect(contractSourceGroup({ selection, owner: 'src', ...after })).toEqual(source)
    expect(source.include).toContain('**/*.nix')
    expect(source.include).not.toContain('missing.unit.test.ts')
    expect(contractSourceGroup({ selection: otherSelection, owner: '.', ...after })).toEqual(
      unaffected,
    )
    put('src/new-package/BUCK.genie.ts')
    expect(discoverContractPackages(root).owners).toContain('src/new-package')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const nativeCommandDeadlineMs = 30_000
it('evaluates compact exclusions with real Buck hidden-file and package-boundary semantics', () => {
  const native = process.env.BUCK2_NATIVE_BIN
  if (native === undefined) throw new Error('Run the owning genie:buck2:test with declared BUCK2_NATIVE_BIN')
  const temporary = path.resolve('tmp/quick-contract-source-groups')
  mkdirSync(temporary, { recursive: true })
  const root = realpathSync(mkdtempSync(path.join(temporary, 'native-')))
  const put = (file: string, content = ''): void => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), content)
  }
  const run = (args: readonly string[]): string => {
    const result = spawnSync(native, ['--isolation-dir', 'quick-contract-glob-fixture', ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: nativeCommandDeadlineMs,
      killSignal: 'SIGKILL',
    })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    if (result.error !== undefined || result.status !== 0)
      throw new Error(`Native Buck ${args.join(' ')} failed (${result.status}): ${output}`, {
        cause: result.error,
      })
    return output.trim()
  }
  let primaryError: unknown
  try {
    put('.buckroot')
    put('.buckconfig', '[cells]\nroot = .\n')
    for (const file of [
      'BUCK',
      'visible.txt',
      '.root-hidden',
      '.github/one/.two/three/.leaf',
      '.github/one/.two/three/node_modules/.hidden/deep.txt',
      '.github/node_modules/pkg.txt',
      '.devenv/cache/.hidden/root.txt',
      '.BUCK.next.probe',
      'node_modules/pkg/file.txt',
      'child/BUCK',
      'child/.hidden',
      'child/child.txt',
    ]) put(file)
    const discovered = discoverContractPackages(root)
    const selected = contractSourceGroup({
      selection: { paths: [], prefixes: [''] },
      owner: '.',
      ...discovered,
    })
    put('BUCK', `_excludes = ${renderContractSourceExclusions(selected.exclusionAnchors)}
print("W9_COMPACT_GLOB=" + repr(glob(${JSON.stringify(selected.include)}, exclude = _excludes)))
`)
    // A missing .buckroot silently queries the parent repository, not this fixture.
    expect(run(['root'])).toBe(root)
    const output = run(['targets', '//...'])
    const marker = 'W9_COMPACT_GLOB='
    const line = output.split('\n').find((value) => value.includes(marker))
    expect(line).toBeDefined()
    expect(JSON.parse(line!.slice(line!.indexOf(marker) + marker.length))).toEqual([
      '.buckconfig',
      '.buckroot',
      '.github/one/.two/three/.leaf',
      '.root-hidden',
      'BUCK',
      'visible.txt',
    ])
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      run(['kill'])
      rmSync(root, { recursive: true, force: true })
    } catch (error) {
      // Preserve the owning fixture when teardown cannot prove daemon shutdown.
      if (primaryError !== undefined)
        throw new AggregateError([primaryError, error], 'Native glob fixture and teardown failed', {
          cause: error,
        })
      throw error
    }
  }
}, 3 * nativeCommandDeadlineMs + 10_000)
