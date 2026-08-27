import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { CompositionCapabilityResolutionError } from './composition-capability-resolver-schema.ts'
import {
  resolveCompositionCapabilities,
  resolvedCompositionCapabilityByToolId,
  type CompositionCapabilityRuntime,
} from './composition-capability-resolver.ts'
import { decodeBuckMemberManifest, type BuckMemberManifest } from './generators/composition-root.ts'

const trackedProjectorPath = fileURLToPath(
  new URL('../../../../../scripts/buck2-capability-project.sh', import.meta.url),
)

const rawShell = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim()
const shell = realpathSync(rawShell)
const commandPath = (name: string): string =>
  execFileSync(shell, ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim()

const tools = {
  bashPath: shell,
  gawkPath: commandPath('gawk'),
  awkPath: commandPath('awk'),
  grepPath: commandPath('grep'),
  jqPath: commandPath('jq'),
  mkdirPath: commandPath('mkdir'),
  rmPath: commandPath('rm'),
  mvPath: commandPath('mv'),
  lnPath: commandPath('ln'),
  readlinkPath: commandPath('readlink'),
  dirnamePath: commandPath('dirname'),
  basenamePath: commandPath('basename'),
  sha256Path: commandPath('sha256sum'),
  sortPath: commandPath('sort'),
  xargsPath: commandPath('xargs'),
  findPath: commandPath('find'),
  flockPath: commandPath('flock'),
  diffPath: commandPath('diff'),
} as const

const bashExecutable = realpathSync(commandPath('bash'))
const bashOutput = NodePath.dirname(NodePath.dirname(bashExecutable))
const alternateExecutable = realpathSync(commandPath('grep'))
const alternateOutput = NodePath.dirname(NodePath.dirname(alternateExecutable))
const escapingStoreOutput = [rawShell, commandPath('nix'), commandPath('grep')]
  .filter((path) => /^\/nix\/store\/[^/]+\/bin\/[^/]+$/u.test(path))
  .map((path) => ({ output: NodePath.dirname(NodePath.dirname(path)), target: realpathSync(path) }))
  .find(({ output, target }) => target.startsWith(`${output}${NodePath.sep}`) === false)?.output

const manifest = ({
  capabilities = [
    {
      toolId: 'buck2',
      protocol: 'facebook/buck2-cli/test',
      flakePackage: 'buck2',
      executable: 'bin/bash',
    },
  ],
}: {
  readonly capabilities?: BuckMemberManifest['capabilities']
} = {}): BuckMemberManifest =>
  decodeBuckMemberManifest({
    schemaVersion: 1,
    cell: 'fixture',
    mount: 'repos/fixture',
    projectIgnore: [],
    distOverlays: [],
    capabilities,
  })

interface Fixture {
  readonly root: string
  readonly memberRoot: string
  readonly scratchRoot: string
  readonly nixLog: string
  readonly runtime: CompositionCapabilityRuntime
}

const makeFixture = async ({
  projector,
}: { readonly projector?: string } = {}): Promise<Fixture> => {
  const root = await mkdtemp(NodePath.join(tmpdir(), 'megarepo-capability-resolver-'))
  const memberRoot = NodePath.join(root, 'member')
  const scratchRoot = NodePath.join(root, 'scratch')
  const scripts = NodePath.join(memberRoot, 'scripts')
  const nixPath = NodePath.join(root, 'fake-nix')
  const nixLog = NodePath.join(root, 'nix.log')
  await Promise.all([mkdir(scripts, { recursive: true }), mkdir(scratchRoot)])
  await writeFile(
    nixPath,
    `#!${shell}\nset -eu\nprintf '%s\\n' "$*" >>"$NIX_LOG"\ncase "\${FAKE_NIX_MODE:-one}" in\n  missing) exit 0 ;;\n  duplicate) printf '%s\\n%s\\n' "$FAKE_NIX_OUTPUT" "$FAKE_NIX_OUTPUT" ;;\n  nonstore) printf '/tmp/not-a-store-output\\n' ;;\n  fail) exit 37 ;;\n  *) printf '%s\\n' "$FAKE_NIX_OUTPUT" ;;\nesac\n`,
    { mode: 0o755 },
  )
  await writeFile(
    NodePath.join(scripts, 'buck2-capability-project.sh'),
    projector ?? (await readFile(trackedProjectorPath, 'utf8')),
    { mode: 0o644 },
  )
  return {
    root,
    memberRoot,
    scratchRoot,
    nixLog,
    runtime: {
      nixPath,
      ...tools,
      env: {
        PATH: '/ambient-path-is-poison',
        NIX_LOG: nixLog,
        FAKE_NIX_OUTPUT: bashOutput,
      },
      nonce: () => 'candidate',
    },
  }
}

const clean = async (fixture: Fixture): Promise<void> =>
  rm(fixture.root, { recursive: true, force: true })

const failure = async (
  promise: Promise<unknown>,
): Promise<CompositionCapabilityResolutionError> => {
  try {
    await promise
    throw new Error('expected resolver failure')
  } catch (cause) {
    expect(cause).toBeInstanceOf(CompositionCapabilityResolutionError)
    return cause as CompositionCapabilityResolutionError
  }
}

const resolve = (
  fixture: Fixture,
  overrides: Partial<Parameters<typeof resolveCompositionCapabilities>[0]> = {},
) =>
  resolveCompositionCapabilities({
    memberRoot: fixture.memberRoot,
    scratchRoot: fixture.scratchRoot,
    system: 'x86_64-linux',
    manifest: manifest(),
    dryRun: false,
    runtime: fixture.runtime,
    ...overrides,
  })

describe('composition capability resolver', () => {
  it('uses exact sorted Nix argv and pinned projector tools despite ambient PATH poison', async () => {
    const fixture = await makeFixture()
    try {
      const result = await resolve(fixture, {
        manifest: manifest({
          capabilities: [
            {
              toolId: 'z-tool',
              protocol: 'test/z/v1',
              flakePackage: 'z-package',
              executable: 'bin/bash',
            },
            {
              toolId: 'a-tool',
              protocol: 'test/a/v1',
              flakePackage: 'a-package',
              executable: 'bin/bash',
            },
          ],
        }),
      })
      expect(result._tag).toBe('Resolved')
      if (result._tag !== 'Resolved') throw new Error('unreachable')
      expect(result.capabilities.map(({ capability }) => capability.toolId)).toEqual([
        'a-tool',
        'z-tool',
      ])
      expect(await readFile(fixture.nixLog, 'utf8')).toBe(
        `build --no-link --print-out-paths ${fixture.memberRoot}#a-package\n` +
          `build --no-link --print-out-paths ${fixture.memberRoot}#z-package\n`,
      )
      expect(result.projectorCommand.args.slice(2, 5)).toEqual([
        'x86_64-linux',
        'a-tool',
        'test/a/v1',
      ])
      expect(result.projectionDigest).toMatch(/^[0-9a-f]{64}$/u)
    } finally {
      await clean(fixture)
    }
  })

  it.each([
    ['missing', 'missing'],
    ['duplicate', 'duplicate'],
    ['non-store', 'nonstore'],
  ] as const)('rejects %s Nix output and removes only its candidate', async (_label, mode) => {
    const fixture = await makeFixture()
    try {
      await writeFile(NodePath.join(fixture.scratchRoot, 'caller-sentinel'), 'owned by caller')
      const error = await failure(
        resolve(fixture, {
          runtime: {
            ...fixture.runtime,
            env: { ...fixture.runtime.env, FAKE_NIX_MODE: mode },
          },
        }),
      )
      expect(error.reason).toBe('InvalidNixOutput')
      expect(await readdir(fixture.scratchRoot)).toEqual(['caller-sentinel'])
    } finally {
      await clean(fixture)
    }
  })

  it('never removes a pre-existing caller path when the candidate name collides', async () => {
    const fixture = await makeFixture()
    try {
      const collision = NodePath.join(fixture.scratchRoot, '.megarepo-capabilities-candidate')
      await mkdir(collision)
      await writeFile(NodePath.join(collision, 'caller-owned'), 'keep')
      expect((await failure(resolve(fixture))).reason).toBe('InvalidInput')
      expect(await readFile(NodePath.join(collision, 'caller-owned'), 'utf8')).toBe('keep')
    } finally {
      await clean(fixture)
    }
  })

  it('rejects a store-output executable whose realpath escapes that output', async () => {
    const fixture = await makeFixture()
    try {
      if (escapingStoreOutput === undefined)
        throw new Error('fixture needs an escaping store symlink')
      const error = await failure(
        resolve(fixture, {
          runtime: {
            ...fixture.runtime,
            env: { ...fixture.runtime.env, FAKE_NIX_OUTPUT: escapingStoreOutput },
          },
        }),
      )
      expect(error.reason).toBe('InvalidExecutable')
      expect(await readdir(fixture.scratchRoot)).toEqual([])
    } finally {
      await clean(fixture)
    }
  })

  it('rejects a missing or non-executable declared output file', async () => {
    const fixture = await makeFixture()
    try {
      const error = await failure(
        resolve(fixture, {
          manifest: manifest({
            capabilities: [
              {
                toolId: 'buck2',
                protocol: 'test/v1',
                flakePackage: 'buck2',
                executable: 'bin/definitely-not-executable',
              },
            ],
          }),
        }),
      )
      expect(error.reason).toBe('InvalidExecutable')
    } finally {
      await clean(fixture)
    }
  })

  it('rejects a missing projector and an escaping projector symlink before Nix runs', async () => {
    const fixture = await makeFixture()
    try {
      await rm(NodePath.join(fixture.memberRoot, 'scripts', 'buck2-capability-project.sh'))
      expect((await failure(resolve(fixture))).reason).toBe('MissingProjector')
      await symlink(
        fixture.runtime.bashPath,
        NodePath.join(fixture.memberRoot, 'scripts', 'buck2-capability-project.sh'),
      )
      expect((await failure(resolve(fixture))).reason).toBe('MissingProjector')
      await expect(readFile(fixture.nixLog, 'utf8')).rejects.toThrow()
    } finally {
      await clean(fixture)
    }
  })

  it.each([
    ['projector', `#!${shell}\nexit 41\n`],
    [
      'check',
      `#!${shell}\nset -eu\nif [ "\${1-}" = --check ]; then exit 42; fi\nroot="$1"\n"$MKDIR_BIN" -p "$root/.buck2/capabilities/generations/${'a'.repeat(64)}"\nprintf '%s\\n' 'GENERATION = "${'a'.repeat(64)}"' >"$root/.buck2/capabilities/defs.bzl"\n`,
    ],
  ] as const)(
    'cleans the candidate on %s failure without mutating the member',
    async (_label, projector) => {
      const fixture = await makeFixture({ projector })
      try {
        const before = await readFile(
          NodePath.join(fixture.memberRoot, 'scripts', 'buck2-capability-project.sh'),
          'utf8',
        )
        expect((await failure(resolve(fixture))).reason).toBe('ProjectionFailure')
        expect(await readdir(fixture.scratchRoot)).toEqual([])
        expect(
          await readFile(
            NodePath.join(fixture.memberRoot, 'scripts', 'buck2-capability-project.sh'),
            'utf8',
          ),
        ).toBe(before)
      } finally {
        await clean(fixture)
      }
    },
  )

  it('plans validated exact argv without invoking Nix or projector', async () => {
    const fixture = await makeFixture({ projector: `#!${shell}\nexit 99\n` })
    try {
      const result = await resolve(fixture, { dryRun: true })
      expect(result).toMatchObject({
        _tag: 'Planned',
        projectorPlatform: 'x86_64-linux',
      })
      expect(result.nixCommands[0]?.args).toEqual([
        'build',
        '--no-link',
        '--print-out-paths',
        `${fixture.memberRoot}#buck2`,
      ])
      expect(result.projectorCommand.args).toContain(
        '/nix/store/00000000000000000000000000000000-planned-buck2/bin/bash',
      )
      expect(await readdir(fixture.scratchRoot)).toEqual([])
      await expect(readFile(fixture.nixLog, 'utf8')).rejects.toThrow()
    } finally {
      await clean(fixture)
    }
  })

  it('changes projection identity with the realized output/executable and supports Buck lookup by toolId', async () => {
    const first = await makeFixture()
    const second = await makeFixture()
    try {
      const firstResult = await resolve(first)
      const secondResult = await resolve(second, {
        manifest: manifest({
          capabilities: [
            {
              toolId: 'buck2',
              protocol: 'facebook/buck2-cli/test',
              flakePackage: 'buck2',
              executable: `bin/${NodePath.basename(alternateExecutable)}`,
            },
          ],
        }),
        runtime: {
          ...second.runtime,
          env: { ...second.runtime.env, FAKE_NIX_OUTPUT: alternateOutput },
        },
      })
      if (firstResult._tag !== 'Resolved' || secondResult._tag !== 'Resolved') {
        throw new Error('unreachable')
      }
      expect(secondResult.projectionDigest).not.toBe(firstResult.projectionDigest)
      expect(
        resolvedCompositionCapabilityByToolId({ resolution: firstResult, toolId: 'buck2' })
          .executablePath,
      ).toBe(bashExecutable)
      expect(() =>
        resolvedCompositionCapabilityByToolId({ resolution: firstResult, toolId: 'missing' }),
      ).toThrow(/absent/u)
    } finally {
      await Promise.all([clean(first), clean(second)])
    }
  })
})
