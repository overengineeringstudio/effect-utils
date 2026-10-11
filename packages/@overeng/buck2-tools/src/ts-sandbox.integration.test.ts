import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

import { runTsSandbox } from './ts-sandbox.ts'

// The repository task deliberately runs this runner package under pinned Bun:
//   devenv tasks run test:buck2-tools
//   devenv tasks run buck2:ts-sandbox:test
// Linux REQUIRES Nix-pinned BWRAP_BIN, BUN_BIN and BUN_CLOSURE_PATHS_JSON
// (a JSON array of exact Nix store closure roots). Missing tools fail the suite.
// Darwin containment is explicitly unsupported; this never gates its required
// local, unsandboxed native-action lane.
type Tools = {
  readonly bubblewrap: string
  readonly bun: string
  readonly closure: readonly string[]
}
type Fixture = {
  readonly root: string
  readonly scratch: string
  readonly output: string
  readonly config: string
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]
  assert(
    value !== undefined && value !== '',
    `Linux TS sandbox integration requires ${name}; missing tooling cannot be skipped`,
  )
  return value
}
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string')

const withFixture = async (run: (fixture: Fixture) => Promise<void>): Promise<void> => {
  // Keep the action cwd outside its private /tmp mount, which is intentionally
  // writable. Each fixture is owned and removed by this test, under repo tmp/.
  const taskTmp = fileURLToPath(new URL('../../../../tmp/ts-sandbox-integration/', import.meta.url))
  await mkdir(taskTmp, { recursive: true })
  const root = await mkdtemp(join(taskTmp, 'run-'))
  try {
    const scratch = join(root, 'scratch')
    const outputDirectory = join(root, 'outputs')
    const config = join(root, 'empty-bunfig.toml')
    await mkdir(scratch)
    await mkdir(outputDirectory)
    await writeFile(config, '')
    await run({ root, scratch, output: join(outputDirectory, 'summary.json'), config })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const receiptCommand = (tools: Tools, fixture: Fixture): readonly string[] => [
  tools.bun,
  '--no-env-file',
  '--no-install',
  `--config=${fixture.config}`,
  '--eval',
  `await Bun.write(${JSON.stringify(fixture.output)}, 'action-executed')`,
]

const runCaptured = async (
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<{
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}> => {
  const { promise, resolve, reject } = Promise.withResolvers<{
    readonly status: number
    readonly stdout: string
    readonly stderr: string
  }>()
  const child = spawn(executable, args, { cwd, env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (data: string) => {
    stdout += data
  })
  child.stderr.setEncoding('utf8').on('data', (data: string) => {
    stderr += data
  })
  child.once('error', reject)
  child.once('close', (code) => resolve({ status: code ?? 1, stdout, stderr }))
  return promise
}

const linuxSuite = process.platform === 'linux' ? describe : describe.skip
linuxSuite('TS sandbox real launcher (Linux required; Darwin containment unsupported)', () => {
  let tools: Tools

  beforeAll(async () => {
    const bubblewrap = await realpath(requiredEnvironment('BWRAP_BIN'))
    const bun = await realpath(requiredEnvironment('BUN_BIN'))
    const closure: unknown = JSON.parse(requiredEnvironment('BUN_CLOSURE_PATHS_JSON'))
    assert(
      strings(closure) && closure.length > 0,
      'BUN_CLOSURE_PATHS_JSON must contain the pinned Bun closure roots',
    )
    for (const executable of [bubblewrap, bun]) {
      assert(
        executable.startsWith('/nix/store/'),
        'integration tooling must use pinned Nix store executables',
      )
      await access(executable, constants.X_OK)
    }
    for (const root of closure) {
      assert(
        /^\/nix\/store\/[^/]+$/.test(root),
        'Bun closure entries must be exact Nix store roots, not broad parents',
      )
      assert((await stat(root)).isDirectory(), `Bun closure root is unavailable: ${root}`)
    }
    assert(
      closure.some((root) => bun.startsWith(`${root}/`)),
      'declared closure does not include the pinned Bun executable',
    )
    tools = { bubblewrap, bun, closure }
    // This positive control is mandatory even for failure-path tests: an
    // unusable host Bubblewrap cannot make the whole Linux suite look green.
    await withFixture(async (fixture) => {
      const status = await runTsSandbox({
        manifest: {
          bubblewrap,
          inputs: [fixture.config],
          outputs: [fixture.output],
          tools: closure,
        },
        command: receiptCommand(tools, fixture),
        scratch: fixture.scratch,
        cwd: fixture.root,
      })
      expect(status).toBe(0)
      expect(await readFile(fixture.output, 'utf8')).toBe('action-executed')
    })
  }, 20_000)

  it('passes the production negative probes and preserves hidden host files and output siblings', async () => {
    await withFixture(async (fixture) => {
      const probe = fileURLToPath(
        new URL('../../../../buck2/tests/ts_sandbox/probe.ts', import.meta.url),
      )
      const closureManifest = join(fixture.root, 'bun-closure.json')
      const sibling = join(fixture.root, 'outputs', 'host-output-sibling')
      const readme = join(fixture.root, 'README.md')
      await writeFile(closureManifest, JSON.stringify(tools.closure))
      await writeFile(readme, 'undeclared repository sentinel')
      await mkdir(join(fixture.root, '.git'))
      await writeFile(sibling, 'host output sibling must remain unchanged')
      const previousSentinel = process.env.TS_SANDBOX_INHERITED_SENTINEL
      process.env.TS_SANDBOX_INHERITED_SENTINEL = 'must-not-enter-action'
      try {
        const status = await runTsSandbox({
          manifest: {
            bubblewrap: tools.bubblewrap,
            inputs: [probe, fixture.config, closureManifest],
            outputs: [fixture.output],
            tools: tools.closure,
          },
          command: [
            tools.bun,
            '--no-env-file',
            '--no-install',
            `--config=${fixture.config}`,
            probe,
            '--input',
            probe,
            '--closure',
            closureManifest,
            '--output',
            fixture.output,
          ],
          scratch: fixture.scratch,
          cwd: fixture.root,
        })
        expect(status).toBe(0)
        expect(JSON.parse(await readFile(fixture.output, 'utf8'))).toEqual({
          status: 'passed',
          boundary: 'linux-bwrap',
          writable: ['isolated-output-directory', 'executor-scratch', 'private-tmp'],
          probes: {
            declaredInputReadable: true,
            declaredInputsReadOnly: true,
            exactBunClosure: true,
            undeclaredRepositoryHidden: true,
            hostHomesHidden: true,
            hostPasswdHidden: true,
            hostOutputSiblingsHidden: true,
            trustedOutputBackingHidden: true,
            outsideWritesDenied: true,
            inheritedEnvironmentCleared: true,
            networkNamespaceIsolated: true,
            externalSocketDenied: true,
          },
        })
        expect(await readFile(readme, 'utf8')).toBe('undeclared repository sentinel')
        expect(await readFile(sibling, 'utf8')).toBe('host output sibling must remain unchanged')
      } finally {
        if (previousSentinel === undefined) delete process.env.TS_SANDBOX_INHERITED_SENTINEL
        else process.env.TS_SANDBOX_INHERITED_SENTINEL = previousSentinel
      }
    })
  }, 20_000)

  it('fails closed when the declared Bubblewrap executable is missing', async () => {
    await withFixture(async (fixture) => {
      await expect(
        runTsSandbox({
          manifest: {
            bubblewrap: join(fixture.root, 'missing-bwrap'),
            inputs: [fixture.config],
            outputs: [fixture.output],
            tools: tools.closure,
          },
          command: receiptCommand(tools, fixture),
          scratch: fixture.scratch,
          cwd: fixture.root,
        }),
      ).rejects.toThrow(
        /Bubblewrap is missing or not executable.*unsandboxed execution is forbidden/,
      )
      await expect(access(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('propagates a real Bubblewrap namespace failure without running the action or falling back', async () => {
    await withFixture(async (fixture) => {
      const launcher = fileURLToPath(new URL('./ts-sandbox.ts', import.meta.url))
      const invocation = {
        manifest: {
          bubblewrap: tools.bubblewrap,
          inputs: [fixture.config],
          outputs: [fixture.output],
          tools: tools.closure,
        },
        command: receiptCommand(tools, fixture),
        scratch: fixture.scratch,
        cwd: fixture.root,
      }
      // Real Bubblewrap creates an outer user namespace and disables nested
      // user namespaces. The same pinned executable then attempts the mandatory
      // production --unshare-all boundary and must return its namespace error.
      // The outer broad bind belongs only to this trusted test harness, never to
      // the production action; no fake executable or shell mock is involved.
      const result = await runCaptured(
        tools.bubblewrap,
        [
          '--unshare-user',
          '--disable-userns',
          '--die-with-parent',
          '--ro-bind',
          '/',
          '/',
          '--bind',
          fixture.root,
          fixture.root,
          '--proc',
          '/proc',
          '--dev',
          '/dev',
          '--chdir',
          fixture.root,
          '--',
          tools.bun,
          '--no-env-file',
          '--no-install',
          `--config=${fixture.config}`,
          '--eval',
          `import { runTsSandbox } from ${JSON.stringify(launcher)}; process.exitCode = await runTsSandbox(${JSON.stringify(invocation)})`,
        ],
        fixture.root,
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/bwrap:.*(?:namespace|userns)/i)
      // This launcher diagnostic proves the outer harness started and the inner
      // production call propagated a nonzero status, rather than failing early.
      expect(result.stderr).toContain('action or Bubblewrap failed (exit ')
      expect(result.stderr).toContain('no unsandboxed fallback')
      await expect(access(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  }, 20_000)
})
