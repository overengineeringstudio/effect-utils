import { describe, expect, it } from 'vitest'

import { contractSourceGroup, contractSourceName, contractSourceOwners, type SourceSelection } from './quick-contract-source-groups.ts'

const owners = ['.', 'buck2', 'buck2/rust', 'rust/empty']
const group = (selection: SourceSelection, owner = '.', directories: readonly string[] = []) =>
  contractSourceGroup({ selection, owner, owners, directories })

describe('per-contract Buck source selectors', () => {
  it('keeps contract identities and selectors separate', () => {
    expect(contractSourceName('lint:check:getflake')).toBe('quick_contract_sources__lint-check-getflake')
    const nix = group({ paths: [], prefixes: [''], extensions: ['.nix'] })
    const shell = group({ paths: [], prefixes: [''], extensions: ['.sh'] })
    expect(nix.include).toContain('**/*.nix')
    expect(nix.include).not.toContain('**/*.sh')
    expect(shell.include).not.toContain('**/*.nix')
  })

  it('declares empty existing owners and nested packages for future matches', () => {
    const selection = { paths: [], prefixes: ['rust/'], extensions: ['.nix'] }
    expect(contractSourceOwners(selection, owners, [])).toContain('rust/empty')
    expect(group({ paths: [], prefixes: ['buck2/'] }, 'buck2/rust').include).toContain('**/*')
  })

  it('retains string prefixes, suffix overlap, and repo-relative explicit inputs', () => {
    expect(group({ paths: [], prefixes: ['scripts/test-tmp'], extensions: ['.sh'] }).include)
      .toEqual(expect.arrayContaining(['scripts/test-tmp*.sh', 'scripts/test-tmp*/**/*.sh']))
    expect(group({ paths: [], prefixes: ['tool.t'], extensions: ['.ts'] }).include).toContain('tool.ts')
    expect(group({ paths: ['buck2/rust/check.unit.test.ts'], prefixes: [] }, 'buck2/rust').include)
      .toEqual(['check.unit.test.ts'])
    expect(group({ paths: ['buck2/rust/check.unit.test.ts'], prefixes: [] }, 'buck2').include).toEqual([])
  })

  it('does not freeze literal tests already selected by a prefix into product BUCK inputs', () => {
    const selected = group({ paths: ['buck2/rust/check.unit.test.ts'], prefixes: ['buck2/'] }, 'buck2/rust')
    expect(selected.include).toContain('**/*')
    expect(selected.include).not.toContain('check.unit.test.ts')
  })

  it('includes hidden files and arbitrary current hidden directory depth', () => {
    const selected = group({ paths: [], prefixes: ['src/'], extensions: ['.ts'] }, '.', ['src/.one/.two/.three'])
    expect(selected.include).toContain('src/**/.*.ts')
    expect(selected.include).toContain('src/.one/.two/.three/**/*.ts')
    expect(selected.exclude).toContain('src/.one/.two/.three/**/node_modules/**/*')
    expect(selected.exclude).toContain('**/target/**/*')
    expect(selected.exclude).toContain('**/.devenv/**/*')
  })

  it('preserves authored membership byte-input pathspec semantics without frozen filenames', () => {
    const selected = group({ paths: [], prefixes: [], membership_inputs: true, membership: ['*.nix'] }, 'buck2')
    expect(selected.include).toContain('**/*.nix')
    expect(() => group({ paths: [], prefixes: [], membership_inputs: true, membership: [':(glob)other/**'] })).toThrow('Unsupported membership byte-input Git pathspec')
  })
})
