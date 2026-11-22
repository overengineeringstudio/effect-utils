import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  contractMembershipDigests,
  decodeMembershipSpecification,
  membershipGitEnvironment,
  profileContractMembershipDigests,
  type ContractMembership,
} from './buck2-contract-membership.ts'
import { directBuckArguments, resolveManagedInvocation } from './buck2-entrypoint.ts'
import { createTestTempDirectoryFactory } from './test-tmp.ts'

const temporary = createTestTempDirectoryFactory()
const git = process.env['WORKTREE_GIT'] ?? 'git'

const fixture = () => {
  const directory = realpathSync(temporary('contract-membership-'))
  const root = join(directory, 'repo')
  mkdirSync(root)
  const config = join(directory, 'gitconfig')
  writeFileSync(
    config,
    '[user]\nname = Fixture\nemail = fixture@example.invalid\n[commit]\ngpgsign = false\n[core]\nhooksPath = /dev/null\n',
  )
  const env = membershipGitEnvironment({ git, root, env: process.env })
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  })
  const run = (...args: string[]) =>
    execFileSync(git, ['-C', root, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  run('init', '--quiet')
  writeFileSync(join(root, 'one.ts'), 'export const one = 1\n')
  run('add', '--', 'one.ts')
  run('commit', '--quiet', '-m', 'fixture')
  const digest = (contracts: Readonly<Record<string, ContractMembership>>, overrides = env) =>
    contractMembershipDigests({
      specification: { schemaVersion: 1, contracts },
      root,
      git,
      env: overrides,
    })
  return { directory, root, env, run, digest }
}
const tracked: ContractMembership = { membership: ['*.ts'], membership_mode: 'tracked' }
const all: ContractMembership = { ...tracked, membership_mode: 'tracked-and-untracked' }

/** Build a synthetic prepared contract fixture using the existing isolated real Git repository. */
export const createPreparedContractMembershipFixture = () => {
  const base = fixture()
  const profile = join(base.directory, 'profile')
  const share = join(profile, 'quick-contracts', 'share')
  const authority = join(base.directory, 'task-authority.json')
  mkdirSync(share, { recursive: true })
  writeFileSync(
    join(share, 'membership-inputs.json'),
    JSON.stringify({ schemaVersion: 1, contracts: { 'test:types': tracked } }),
  )
  writeFileSync(authority, '{}\n')
  // This receipt belongs only to this synthetic fixture, never a real checkout.
  mkdirSync(join(base.root, '.devenv'))
  writeFileSync(
    join(base.root, '.devenv', 'quick-contracts-prepared'),
    `${authority}\n${profile}\n`,
  )
  const gitExecPath = execFileSync(git, ['--exec-path'], { env: base.env, encoding: 'utf8' }).trim()
  return {
    ...base,
    env: {
      ...base.env,
      WORKTREE_CAPABILITIES_PROFILE: profile,
      WORKTREE_GIT: realpathSync(join(gitExecPath, 'git')),
    },
  }
}

describe('live quick-contract Git membership', () => {
  it('is unchanged by content edits, staging, commits, and unrelated HEAD changes', () => {
    const { root, run, digest } = fixture()
    const before = digest({ 'test:types': tracked })
    expect(digest({ 'test:types': tracked })).toEqual(before)
    expect(Object.values(before)[0]).toMatch(/^[0-9a-f]{64}$/u)
    writeFileSync(join(root, 'one.ts'), 'export const one = 2\n')
    expect(digest({ 'test:types': tracked })).toEqual(before)
    run('add', '--', 'one.ts')
    expect(digest({ 'test:types': tracked })).toEqual(before)
    run('commit', '--quiet', '-m', 'edit same member')
    expect(digest({ 'test:types': tracked })).toEqual(before)
    writeFileSync(join(root, 'unrelated.txt'), 'unrelated\n')
    run('add', '--', 'unrelated.txt')
    run('commit', '--quiet', '-m', 'unrelated HEAD')
    expect(digest({ 'test:types': tracked })).toEqual(before)
  })

  it('invalidates on new tracked names without requiring a commit or preparation', () => {
    const { root, run, digest } = fixture()
    const before = digest({ check: tracked })
    writeFileSync(join(root, 'two.ts'), 'export const two = 2\n')
    expect(digest({ check: tracked })).toEqual(before)
    run('add', '--', 'two.ts')
    const added = digest({ check: tracked })
    expect(added).not.toEqual(before)
    run('commit', '--quiet', '-m', 'new member')
    expect(digest({ check: tracked })).toEqual(added)
    run('rm', '--', 'two.ts')
    expect(digest({ check: tracked })).toEqual(before)
  })

  it('distinguishes tracked and untracked modes and honors ignore/pathspec semantics', () => {
    const { root, run, digest } = fixture()
    writeFileSync(join(root, '.gitignore'), 'ignored.ts\n')
    const before = digest({ tracked, all })
    expect(before['quick_contracts.membership_tracked']).not.toEqual(
      before['quick_contracts.membership_all'],
    )
    writeFileSync(join(root, 'ignored.ts'), 'ignored\n')
    expect(digest({ tracked, all })).toEqual(before)
    writeFileSync(join(root, 'two.ts'), 'new\n')
    const untracked = digest({ tracked, all })
    expect(untracked['quick_contracts.membership_tracked']).toEqual(
      before['quick_contracts.membership_tracked'],
    )
    expect(untracked['quick_contracts.membership_all']).not.toEqual(
      before['quick_contracts.membership_all'],
    )
    run('add', '--', 'two.ts')
    const staged = digest({ tracked, all })
    expect(staged['quick_contracts.membership_all']).toEqual(
      untracked['quick_contracts.membership_all'],
    )
    expect(staged['quick_contracts.membership_tracked']).not.toEqual(
      before['quick_contracts.membership_tracked'],
    )
    const literal = { membership: [':(literal)one.ts'], membership_mode: 'tracked' } as const
    expect(digest({ check: literal })).not.toEqual(digest({ check: tracked }))
  })

  it('queries identical canonical pattern groups once per invocation using real Git tracing', () => {
    const { directory, digest, env } = fixture()
    const trace = join(directory, 'git-trace')
    const contracts = {
      'check:first': { ...tracked, membership: ['one.ts', '*.ts', '*.ts'] },
      'check:second': { ...tracked, membership: ['*.ts', 'one.ts'] },
      'check:all': all,
    }
    const first = digest(contracts, { ...env, GIT_TRACE: trace })
    expect(first['quick_contracts.membership_check-first']).toEqual(
      first['quick_contracts.membership_check-second'],
    )
    const queries = () =>
      readFileSync(trace, 'utf8')
        .split('\n')
        .filter((line) => line.includes('built-in: git ls-files')).length
    expect(queries()).toBe(2)
    expect(digest(contracts, { ...env, GIT_TRACE: trace })).toEqual(first)
    expect(queries()).toBe(4)
  })

  it('isolates stale hook-local repository/index/config environment with Git declared variables', () => {
    const { root, directory, env, digest } = fixture()
    const baseline = digest({ check: tracked })
    const stale = {
      ...env,
      GIT_DIR: join(directory, 'missing.git'),
      GIT_WORK_TREE: join(directory, 'wrong-root'),
      GIT_COMMON_DIR: join(directory, 'wrong-common'),
      GIT_INDEX_FILE: join(directory, 'wrong-index'),
      GIT_OBJECT_DIRECTORY: join(directory, 'wrong-objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(directory, 'wrong-alternates'),
      GIT_PREFIX: 'hook-prefix/',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.bare',
      GIT_CONFIG_VALUE_0: 'true',
    }
    expect(digest({ check: tracked }, stale)).toEqual(baseline)
    expect(membershipGitEnvironment({ git, root, env: stale })['GIT_CONFIG_GLOBAL']).toBe(
      env['GIT_CONFIG_GLOBAL'],
    )
  })

  it('preserves foreign non-Git Buck dispatch with an inherited full membership profile', async () => {
    const { directory, env } = fixture()
    const profile = join(directory, 'foreign-inherited-profile')
    const share = join(profile, 'quick-contracts', 'share')
    mkdirSync(share, { recursive: true })
    writeFileSync(
      join(share, 'membership-inputs.json'),
      JSON.stringify({ schemaVersion: 1, contracts: { 'test:types': tracked } }),
    )
    const root = join(directory, 'foreign-non-git')
    mkdirSync(root)
    writeFileSync(join(root, '.buckroot'), '')
    writeFileSync(join(root, '.buckconfig'), '[buck2]\nremote_cache_enabled = false\n')
    const inherited = {
      ...env,
      WORKTREE_CAPABILITIES_PROFILE: profile,
      WORKTREE_GIT: undefined,
      FRACTAL_AGENT: 'fixture-actor',
      WORKTREE_POLICY_PATH: '/fixture-policy',
    }
    expect(profileContractMembershipDigests({ root, env: inherited })).toEqual({})
    const args = ['build', '//:fixture']
    expect(await directBuckArguments({ args, cwd: root, env: inherited })).toEqual(args)
  })

  it('loads optional immutable profile data and refuses missing/malformed declared specifications', async () => {
    const { root, directory, env, digest } = fixture()
    const profile = join(directory, 'profile')
    mkdirSync(profile)
    const selected = { ...env, WORKTREE_CAPABILITIES_PROFILE: profile }
    expect(profileContractMembershipDigests({ root, env: selected })).toEqual({})
    const packageRoot = join(directory, 'package')
    mkdirSync(join(packageRoot, 'share'), { recursive: true })
    symlinkSync(packageRoot, join(profile, 'quick-contracts'))
    // This protocol receipt belongs only to the synthetic fixture, never a real checkout.
    mkdirSync(join(root, '.devenv'))
    writeFileSync(
      join(root, '.devenv', 'quick-contracts-prepared'),
      `${join(directory, 'task-authority.json')}\n${profile}\n`,
    )
    expect(() => profileContractMembershipDigests({ root, env: selected })).toThrow(
      'required membership specification',
    )
    const path = join(packageRoot, 'share', 'membership-inputs.json')
    writeFileSync(path, '{"schemaVersion":2,"contracts":{}}')
    expect(() => profileContractMembershipDigests({ root, env: selected })).toThrow(
      'required membership specification',
    )
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, contracts: { 'test:types': tracked } }))
    expect(() =>
      profileContractMembershipDigests({ root, env: { ...selected, WORKTREE_GIT: undefined } }),
    ).toThrow('WORKTREE_GIT')
    const absoluteGit = execFileSync(git, ['--exec-path'], { env, encoding: 'utf8' }).trim()
    // Git's own exec-path contains git, avoiding a shell/PATH-resolution helper.
    const gitBinary = realpathSync(join(absoluteGit, 'git'))
    expect(
      profileContractMembershipDigests({ root, env: { ...selected, WORKTREE_GIT: gitBinary } }),
    ).toEqual(digest({ 'test:types': tracked }))
    writeFileSync(join(root, '.buckroot'), '')
    writeFileSync(
      join(root, '.buckconfig'),
      '[buck2]\nremote_cache_enabled = false\nallow_cache_uploads = false\n',
    )
    const argfile = join(directory, 'arguments')
    writeFileSync(argfile, 'run\n//:check-quick\n--\n--literal-tool-argument\n')
    const managedEnv = { ...selected, WORKTREE_GIT: gitBinary }
    const canonical = resolveManagedInvocation({
      args: [`@${argfile}`],
      cwd: root,
      env: managedEnv,
    })
    const admitted = await directBuckArguments({ args: canonical.args, cwd: root, env: managedEnv })
    const key = 'quick_contracts.membership_test-types'
    expect(admitted).toContain(`${key}=${digest({ 'test:types': tracked })[key]}`)
    expect(admitted.slice(admitted.indexOf('--'))).toEqual(['--', '--literal-tool-argument'])
    expect(admitted.some((arg) => arg.includes('one.ts'))).toBe(false)
    writeFileSync(join(root, 'two.ts'), 'new tracked contract member\n')
    execFileSync(git, ['-C', root, 'add', '--', 'two.ts'], {
      env: managedEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const refreshed = await directBuckArguments({
      args: canonical.args,
      cwd: root,
      env: managedEnv,
    })
    expect(refreshed).toContain(`${key}=${digest({ 'test:types': tracked })[key]}`)
    expect(refreshed).not.toContain(admitted.find((arg) => arg.startsWith(`${key}=`)))
  })

  it('rejects invalid modes, empty memberships, and colliding config task keys', () => {
    for (const contracts of [
      { check: { membership: ['*.ts'], membership_mode: 'unknown' } },
      { check: { membership: [], membership_mode: 'tracked' } },
      { 'test:types': tracked, 'test-types': tracked },
    ])
      expect(() => decodeMembershipSpecification({ schemaVersion: 1, contracts })).toThrow(
        'invalid membership specification',
      )
  })
})
