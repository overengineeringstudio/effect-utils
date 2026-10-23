import { describe, expect, it } from 'bun:test'
import * as os from 'node:os'
import * as path from 'node:path'
import { runInNewContext } from 'node:vm'

import { defaultRefPolicyCheckScript } from './default-ref-policy-script.ts'
import { defaultRefPolicyCheckStep, type DefaultRefPolicyCheckStepOptions } from './megarepo.ts'

// The embedded Node script has no module API. Supply its filesystem and git
// boundaries in memory so the complete check runs without network or processes.
const runPolicy = ({
  ref,
  repo = 'overengineeringstudio/effect-utils',
  commit = 'published-commit',
  options = {},
}: {
  ref?: string
  repo?: string
  commit?: string
  options?: DefaultRefPolicyCheckStepOptions
}) => {
  const errors: string[] = []
  const gitCalls: string[][] = []
  let exitCode: number | undefined
  const exit = Symbol('exit')
  const lock = JSON.stringify({
    members: { dependency: { url: `https://github.com/${repo}`, ref, commit } },
  })
  const fs = {
    existsSync: () => false,
    readdirSync: () => ['megarepo.lock'],
    statSync: () => ({ isDirectory: () => false, isFile: () => true }),
    readFileSync: () => lock,
    mkdtempSync: () => '/fixture/git',
    rmSync: () => undefined,
  }
  const cp = {
    execFileSync: (_command: string, args: string[]) => {
      gitCalls.push(args)
      if (args.includes('merge-base')) {
        const branch = args.at(-1)
        // main-commit is ahead of published; unreachable-commit is on neither branch.
        if (
          commit === 'unreachable-commit' ||
          (commit === 'main-commit' && branch !== 'refs/remotes/origin/main')
        ) {
          throw new Error('commit is not reachable from this branch')
        }
      }
    },
  }
  const modules: Record<string, unknown> = {
    'node:fs': fs,
    'node:path': path,
    'node:os': os,
    'node:child_process': cp,
  }
  try {
    runInNewContext(defaultRefPolicyCheckScript, {
      require: (name: string) => modules[name],
      URLSearchParams,
      process: {
        cwd: () => '/fixture',
        env: defaultRefPolicyCheckStep(options).env,
        exit: (code: number) => {
          exitCode = code
          throw exit
        },
      },
      console: { log: () => undefined, error: (message: string) => errors.push(message) },
    })
  } catch (error) {
    if (error !== exit) throw error
  }
  return { exitCode, errors: errors.join('\n'), gitCalls }
}

describe('default-ref policy script', () => {
  it.each(['published', 'main'])('accepts effect-utils %s', (ref) => {
    expect(runPolicy({ ref }).exitCode).toBe(0)
  })

  it('rejects feature refs and names the preferred default and accepted refs', () => {
    const result = runPolicy({ ref: 'feature/test', options: { verifyReachable: true } })
    expect(result.exitCode).toBe(1)
    expect(result.errors).toContain("default 'published'; accepted refs: published, main")
    expect(result.gitCalls).toHaveLength(0)
  })

  it.each(['', undefined])('rejects an empty or missing lock ref (%s) with an unreachable commit', (ref) => {
    const result = runPolicy({
      ref,
      commit: 'unreachable-commit',
      options: { verifyReachable: true },
    })
    expect(result.exitCode).toBe(1)
    expect(result.errors).toContain("uses ref '' in members.ref")
    expect(result.errors).toContain("default 'published'; accepted refs: published, main")
  })

  it('rejects empty lock refs even without reachability verification', () => {
    expect(runPolicy({ ref: '' }).exitCode).toBe(1)
  })

  it('keeps other first-party repositories strict and preserves the livestore override', () => {
    expect(runPolicy({ repo: 'schickling/other', ref: 'main' }).exitCode).toBe(0)
    expect(runPolicy({ repo: 'schickling/other', ref: 'published' }).exitCode).toBe(1)
    const options = {
      firstPartyOwners: ['livestorejs'],
      defaultRefs: { 'livestorejs/livestore': 'dev' },
    }
    expect(runPolicy({ repo: 'livestorejs/livestore', ref: 'dev', options }).exitCode).toBe(0)
    expect(runPolicy({ repo: 'livestorejs/livestore', ref: 'main', options }).exitCode).toBe(1)
  })

  it('replaces both built-in defaults and accepted refs with a caller override', () => {
    const options = { defaultRefs: { 'OverEngineeringStudio/Effect-Utils': 'release' } }
    expect(runPolicy({ ref: 'release', options }).exitCode).toBe(0)
    for (const ref of ['main', 'published']) {
      const result = runPolicy({ ref, options })
      expect(result.exitCode).toBe(1)
      expect(result.errors).toContain("default 'release'; accepted refs: release")
    }
  })

  it('checks main-ahead and published pins against their actual accepted branch', () => {
    const options = { verifyReachable: true, normalizeGitBranchRefs: true }
    const main = runPolicy({ ref: 'refs/heads/main', commit: 'main-commit', options })
    expect(main.exitCode).toBe(0)
    expect(main.gitCalls.find((args) => args.includes('fetch'))?.at(-1)).toBe(
      'refs/heads/main:refs/remotes/origin/main',
    )
    expect(main.gitCalls.find((args) => args.includes('merge-base'))?.at(-1)).toBe(
      'refs/remotes/origin/main',
    )
    const published = runPolicy({ ref: 'published', options })
    expect(published.exitCode).toBe(0)
    expect(published.gitCalls.find((args) => args.includes('merge-base'))?.at(-1)).toBe(
      'refs/remotes/origin/published',
    )
    // Control: the same main-ahead commit cannot pass as a published pin.
    const unpublished = runPolicy({ ref: 'published', commit: 'main-commit', options })
    expect(unpublished.exitCode).toBe(1)
    expect(unpublished.errors).toContain("default 'published'; accepted refs: published, main")
  })
})
