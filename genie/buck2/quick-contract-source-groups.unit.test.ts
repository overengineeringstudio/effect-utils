import { describe, expect, it } from 'vitest'

import targetCatalog from '../../nix/quick-contracts-targets.json'
import {
  contractSourceGroup,
  contractSourceName,
  contractSourceOwners,
  renderContractSourceExclusions,
  type SourceSelection,
} from './quick-contract-source-groups.ts'

const owners = ['.', 'buck2', 'buck2/rust', 'rust/empty']
const group = (selection: SourceSelection, owner = '.', directories: readonly string[] = []) =>
  contractSourceGroup({ selection, owner, owners, directories })

describe('per-contract Buck source selectors', () => {
  it('keeps contract identities and selectors separate', () => {
    expect(contractSourceName('lint:check:getflake')).toBe(
      'quick_contract_sources__lint-check-getflake',
    )
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
    expect(
      group({ paths: [], prefixes: ['scripts/test-tmp'], extensions: ['.sh'] }).include,
    ).toEqual(expect.arrayContaining(['scripts/test-tmp*.sh', 'scripts/test-tmp*/**/*.sh']))
    expect(group({ paths: [], prefixes: ['tool.t'], extensions: ['.ts'] }).include).toContain(
      'tool.ts',
    )
    expect(
      group({ paths: ['buck2/rust/check.unit.test.ts'], prefixes: [] }, 'buck2/rust').include,
    ).toEqual(['check.unit.test.ts'])
    expect(
      group({ paths: ['buck2/rust/check.unit.test.ts'], prefixes: [] }, 'buck2').include,
    ).toEqual([])
  })

  it('does not freeze literal tests already selected by a prefix into product BUCK inputs', () => {
    const selected = group(
      { paths: ['buck2/rust/check.unit.test.ts'], prefixes: ['buck2/'] },
      'buck2/rust',
    )
    expect(selected.include).toContain('**/*')
    expect(selected.include).not.toContain('check.unit.test.ts')
  })

  it('includes hidden files and arbitrary current hidden directory depth', () => {
    const selected = group({ paths: [], prefixes: ['src/'], extensions: ['.ts'] }, '.', [
      'src/.one/.two/.three',
    ])
    expect(selected.include).toContain('src/**/.*.ts')
    expect(selected.include).toContain('src/.one/.two/.three/**/*.ts')
    expect(selected.exclusionAnchors).toContain('src/.one/.two/.three/')
    const exclusions = renderContractSourceExclusions(selected.exclusionAnchors)
    expect(exclusions).toContain('"node_modules"')
    expect(exclusions).toContain('"target"')
    expect(exclusions).toContain('".devenv"')
  })

  it('keeps unrelated child packages and ordinary hidden descendants out of the pattern product', () => {
    const selection = { paths: [], prefixes: ['src/'] }
    const directories = ['.github', 'src/.owned', 'src/.owned/ordinary']
    const selected = group(selection, '.', directories)
    const childDirectories = Array.from({ length: 2_000 }, (_, index) => `buck2/.hidden-${index}`)
    expect(group(selection, '.', [...directories, ...childDirectories])).toEqual(selected)
    expect(selected.exclusionAnchors).toEqual(['', '.github/', 'src/.owned/'])
    expect(selected.include).toContain('src/.owned/**/*')
    expect(selected.include.some((pattern) => pattern.startsWith('src/.github/'))).toBe(false)
    // Render the product, not its millions of entries once per contract.
    expect(renderContractSourceExclusions(selected.exclusionAnchors).length).toBeLessThan(2_000)
  })

  it('preserves authored membership byte-input pathspec semantics without frozen filenames', () => {
    const selected = group(
      { paths: [], prefixes: [], membership_inputs: true, membership: ['*.nix'] },
      'buck2',
    )
    expect(selected.include).toContain('**/*.nix')
    expect(() =>
      group({ paths: [], prefixes: [], membership_inputs: true, membership: [':(glob)other/**'] }),
    ).toThrow('Unsupported membership byte-input Git pathspec')
  })

  it.each([
    ['buck2:cache-admission:check', 'nix/buck2-rules/patches/rust-action-adapter.patch'],
    ['buck2:cache-posture:ci-test', '.buckconfig'],
    ['buck2:cache-posture:ci-test', 'genie/ci-scripts/buck2-action-evidence-codec.ts'],
    ['buck2:cache-posture:ci-test', 'genie/ci-scripts/buck2-cache-evidence.ts'],
    ['buck2:cache-posture:test', '.buckconfig'],
    ['buck2:cache-posture:test', 'buck2/quick_contracts.bzl'],
    ['buck2:cache-posture:test', 'genie/ci-scripts/buck2-action-evidence-codec.ts'],
    ['buck2:cache-posture:test', 'genie/ci-scripts/buck2-cache-evidence.ts'],
    [
      'buck2:capabilities:test',
      'nix/devenv-modules/tasks/shared/tests/buck2-capability-watcher-change.jq',
    ],
    ['buck2:task-guards:check', 'buck2-test-authority.json'],
    ['buck2:task-guards:check', 'buck2/toolchains/BUCK'],
    ['buck2:task-guards:check', 'buck2/toolchains/configured.bzl'],
    ['buck2:task-guards:check', 'genie/ci-workflow/test-platforms.json'],
    ['buck2:task-guards:check', 'genie/ci-workflow/test-scheduling.json'],
    [
      'buck2:task-guards:check',
      'packages/@overeng/utils-dev/src/check-baseline-test-collection.ts',
    ],
  ] as const)('projects %s real input %s into its owning Buck package', (task, file) => {
    const dependencyOwners = [...owners, 'buck2/toolchains', 'packages/@overeng/utils-dev']
    const owner = dependencyOwners
      .toSorted((left, right) => right.length - left.length)
      .find((candidate) => candidate === '.' || file.startsWith(`${candidate}/`))!
    const selection = targetCatalog[task]
    expect(contractSourceOwners(selection, dependencyOwners, [])).toContain(owner)
    expect(
      contractSourceGroup({ selection, owner, owners: dependencyOwners, directories: [] }).include,
    ).toContain(owner === '.' ? file : file.slice(owner.length + 1))
  })
})
