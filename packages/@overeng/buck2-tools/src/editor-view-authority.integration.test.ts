import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  type EditorViewAuthorityCommandRunner,
  writeEditorViewAuthority,
} from './editor-view-authority.ts'

type Fixture = {
  readonly root: string
  readonly output: string
}

const makeFixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'editor-view-authority-'))
  const output = join(root, '.devenv', 'editor-workspace-authority.json')
  mkdirSync(join(root, '.devenv'))
  return { root, output }
}

const makeRunner = ({
  missing = false,
  nonAdmittedOwned = false,
}: {
  missing?: boolean
  nonAdmittedOwned?: boolean
} = {}) => {
  const calls: Parameters<EditorViewAuthorityCommandRunner>[0][] = []
  const ownershipCandidates: string[] = []
  const runCommand: EditorViewAuthorityCommandRunner = (invocation) => {
    calls.push(invocation)
    if (invocation.command.endsWith('/git') === true)
      return {
        status: 0,
        stdout: Buffer.from('packages/z/package.json\0packages/a/package.json\0'),
        stderr: Buffer.from(''),
      }
    const argument = invocation.args[4]
    if (argument === undefined || argument.startsWith('@') === false)
      throw new Error('expected Buck argument file')
    const candidates = readFileSync(argument.slice(1), 'utf8').trim().split('\n')
    ownershipCandidates.push(...candidates)
    return {
      status: 0,
      stdout: Buffer.from(
        JSON.stringify(
          Object.fromEntries(
            candidates.map((candidate) => {
              const packagePath = candidate.slice(0, -'/package.json'.length)
              const owned =
                packagePath === 'packages/a' ? missing === false : nonAdmittedOwned === true
              return [
                candidate,
                owned === true ? [`effect_utils//${packagePath}:package.json`] : [],
              ]
            }),
          ),
        ),
      ),
      stderr: Buffer.from(''),
    }
  }
  return { calls, ownershipCandidates, runCommand }
}

describe('editor view authority production flow', () => {
  it('joins the semantic package registry to one grouped Buck ownership census atomically', async () => {
    const fixture = makeFixture()
    try {
      writeFileSync(fixture.output, 'stale\n')
      const { calls, runCommand } = makeRunner()
      const authority = await writeEditorViewAuthority({
        repoRoot: fixture.root,
        workspaceRoot: fixture.root,
        requiredPackages: ['packages/a'],
        cell: 'effect_utils',
        buck2: '/nix/store/test-buck2/bin/buck2',
        git: '/nix/store/test-git/bin/git',
        output: fixture.output,
        runCommand,
      })
      expect(calls).toHaveLength(2)
      expect(calls[0]?.args).toEqual(['ls-files', '--cached', '-z', '--', ':(glob)**/package.json'])
      expect(calls[1]?.args.slice(0, 4)).toEqual(['uquery', '--output-format', 'json', 'owner(%s)'])
      expect(authority).toEqual({
        schema: 'effect-utils/workspace-dependency-authority/v1',
        requiredPackages: ['packages/a'],
        ownedPackages: ['packages/a'],
      })
      expect(JSON.parse(readFileSync(fixture.output, 'utf8'))).toEqual(authority)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails before replacing the prior authority when Buck ownership is incomplete', async () => {
    const fixture = makeFixture()
    try {
      writeFileSync(fixture.output, 'prior-authority\n')
      const { runCommand } = makeRunner({ missing: true })
      await expect(
        writeEditorViewAuthority({
          repoRoot: fixture.root,
          workspaceRoot: fixture.root,
          requiredPackages: ['packages/a'],
          cell: 'effect_utils',
          buck2: '/nix/store/test-buck2/bin/buck2',
          git: '/nix/store/test-git/bin/git',
          output: fixture.output,
          runCommand,
        }),
      ).rejects.toThrow(
        'whole-workspace dependency authority mismatch: missing=["packages/a"] extra=[]',
      )
      expect(readFileSync(fixture.output, 'utf8')).toBe('prior-authority\n')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('excludes a non-admitted Buck package from the ownership census', async () => {
    const fixture = makeFixture()
    try {
      writeFileSync(fixture.output, 'prior-authority\n')
      const { ownershipCandidates, runCommand } = makeRunner({ nonAdmittedOwned: true })
      const authority = await writeEditorViewAuthority({
        repoRoot: fixture.root,
        workspaceRoot: fixture.root,
        requiredPackages: ['packages/a'],
        cell: 'effect_utils',
        buck2: '/nix/store/test-buck2/bin/buck2',
        git: '/nix/store/test-git/bin/git',
        output: fixture.output,
        runCommand,
      })
      expect(ownershipCandidates).toEqual(['packages/a/package.json'])
      expect(authority).toEqual({
        schema: 'effect-utils/workspace-dependency-authority/v1',
        requiredPackages: ['packages/a'],
        ownedPackages: ['packages/a'],
      })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
