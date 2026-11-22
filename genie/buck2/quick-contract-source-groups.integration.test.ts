import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { expect, it } from 'vitest'

import {
  contractSourceGroup,
  contractSourceOwners,
  discoverContractPackages,
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
