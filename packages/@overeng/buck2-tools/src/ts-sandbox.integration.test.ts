import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

// The repository task deliberately runs this runner package under pinned Bun:
//   devenv tasks run test:buck2-tools
//   devenv tasks run buck2:ts-sandbox:test
// Linux REQUIRES Nix-pinned BWRAP_BIN, BUN_BIN and BASH_BIN, plus the real
// analysis-generated TS_SANDBOX_LAUNCHER and absolute TS_SANDBOX_PROBE_OUTPUT.
// Missing tools or generated artifacts fail the suite, never skip it.
// Darwin containment is explicitly unsupported; this never gates its required
// local, unsandboxed native-action lane.
type Tools = {
  readonly bubblewrap: string
  readonly bun: string
  readonly bash: string
  readonly repoRoot: string
  readonly launcherSource: string
  readonly outputDirectory: string
}
type Fixture = {
  readonly root: string
  readonly scratch: string
  readonly tmp: string
  readonly outputDirectory: string
  readonly output: string
  readonly launcher: string
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]
  assert(
    value !== undefined && value !== '',
    `Linux TS sandbox integration requires ${name}; missing tooling cannot be skipped`,
  )
  return value
}

const withFixture = async (
  tools: Tools,
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> => {
  // The launcher must keep its actual repository cwd for analysis-owned inputs.
  // Fixtures live outside the private /tmp mount and own every writable host path.
  const taskTmp = join(tools.repoRoot, 'tmp', 'ts-sandbox-integration')
  await mkdir(taskTmp, { recursive: true })
  const root = await mkdtemp(join(taskTmp, 'run-'))
  try {
    const scratch = join(root, 'scratch')
    const tmp = join(root, 'tmp')
    const outputDirectory = join(root, 'outputs')
    const launcher = join(root, 'ts-sandbox.sh')
    await mkdir(scratch)
    await mkdir(tmp)
    // Only relocate the declared output directory. Commands, exact input binds
    // and tool closure binds remain those emitted by production Buck analysis.
    await writeFile(
      launcher,
      tools.launcherSource.replaceAll(
        tools.outputDirectory,
        relative(tools.repoRoot, outputDirectory),
      ),
    )
    // Do not create outputs here: the real generated launcher owns that step.
    await run({
      root,
      scratch,
      tmp,
      outputDirectory,
      output: join(outputDirectory, 'summary.json'),
      launcher,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const runCaptured = async (
  executable: string,
  args: readonly string[],
  tools: Tools,
  fixture: Fixture,
  environment: NodeJS.ProcessEnv = {
    BUCK_SCRATCH_PATH: fixture.scratch,
    TMPDIR: fixture.tmp,
  },
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
  const child = spawn(executable, args, {
    cwd: tools.repoRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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

const runLauncher = (tools: Tools, fixture: Fixture) =>
  runCaptured(tools.bash, ['--noprofile', '--norc', fixture.launcher], tools, fixture)

const expectProbeReceipt = async (fixture: Fixture): Promise<void> => {
  expect(JSON.parse(await readFile(fixture.output, 'utf8'))).toEqual({
    status: 'passed',
    boundary: 'linux-bwrap',
    writable: ['declared-output-directory', 'executor-scratch', 'private-tmp'],
    probes: {
      declaredInputReadable: true,
      declaredInputsReadOnly: true,
      exactBunClosure: true,
      undeclaredRepositoryHidden: true,
      hostHomesHidden: true,
      hostPasswdHidden: true,
      hostOutputSiblingsHidden: true,
      outsideWritesDenied: true,
      inheritedEnvironmentCleared: true,
      networkNamespaceIsolated: true,
      externalSocketDenied: true,
    },
  })
}

const linuxSuite = process.platform === 'linux' ? describe : describe.skip
linuxSuite('TS sandbox generated shell (Linux required; Darwin containment unsupported)', () => {
  let tools: Tools

  beforeAll(async () => {
    const bubblewrap = requiredEnvironment('BWRAP_BIN')
    const bun = requiredEnvironment('BUN_BIN')
    const bash = requiredEnvironment('BASH_BIN')
    for (const executable of [bubblewrap, bun, bash]) {
      assert(
        executable.startsWith('/nix/store/') &&
          (await realpath(executable)).startsWith('/nix/store/'),
        'integration tooling must use pinned Nix store executables',
      )
      await access(executable, constants.X_OK)
    }
    const repoRoot = await realpath(fileURLToPath(new URL('../../../../', import.meta.url)))
    const launcher = requiredEnvironment('TS_SANDBOX_LAUNCHER')
    const probeOutput = requiredEnvironment('TS_SANDBOX_PROBE_OUTPUT')
    assert(isAbsolute(launcher), 'TS_SANDBOX_LAUNCHER must be the generated script absolute path')
    assert(
      isAbsolute(probeOutput),
      'TS_SANDBOX_PROBE_OUTPUT must be the summary.json absolute path',
    )
    assert((await stat(launcher)).isFile(), 'the analysis-generated launcher must exist')
    await access(probeOutput, constants.R_OK)
    const outputDirectory = relative(repoRoot, dirname(await realpath(probeOutput)))
    assert(
      outputDirectory !== '' &&
        outputDirectory !== '..' &&
        !outputDirectory.startsWith('../') &&
        !isAbsolute(outputDirectory),
      'the production probe output directory must be inside the repository',
    )
    const launcherSource = await readFile(launcher, 'utf8')
    assert(
      launcherSource.includes(outputDirectory),
      'the generated launcher must reference the declared probe output directory',
    )
    assert(
      launcherSource.includes(bubblewrap),
      'BWRAP_BIN must match the exact pinned executable in the generated launcher',
    )
    tools = { bubblewrap, bun, bash, repoRoot, launcherSource, outputDirectory }
    // Mandatory positive control even when selecting only failure-path tests:
    // an unusable host Bubblewrap must never make the Linux suite look green.
    await withFixture(tools, async (fixture) => {
      const result = await runLauncher(tools, fixture)
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      await expectProbeReceipt(fixture)
    })
  }, 20_000)

  it('copies the declared runtime closure from an immutable external cell without admitting sibling imports', async () => {
    await withFixture(tools, async (fixture) => {
      const buck = requiredEnvironment('BUCK2_BIN')
      await access(buck, constants.X_OK)
      const root = join(fixture.root, 'workspace')
      const rules = join(fixture.root, 'runtime-rules')
      const sources = join(fixture.root, 'immutable-sources')
      const rulesSources = join(rules, 'src')
      await mkdir(root)
      await mkdir(rulesSources, { recursive: true })
      await mkdir(sources)
      const generated = await readFile(
        join(tools.repoRoot, 'packages/@overeng/buck2-tools/BUCK'),
        'utf8',
      )
      const runtime = /runtime_modules\(\n    name = "package_tree_runtime",[\s\S]*?\n\)/u.exec(
        generated,
      )?.[0]
      assert(runtime !== undefined, 'the fixture must use the production runtime declaration')
      const modules = ['package-tree.ts', 'real-path.ts']
      for (const module of modules) {
        await writeFile(
          join(sources, module),
          await readFile(join(tools.repoRoot, 'packages/@overeng/buck2-tools/src', module)),
        )
      }
      await writeFile(
        join(sources, 'undeclared-entry.ts'),
        `${await readFile(join(sources, 'package-tree.ts'), 'utf8')}\nimport './undeclared.ts'\n`,
      )
      await writeFile(
        join(sources, 'undeclared.ts'),
        "throw new Error('UNDECLARED_RULES_CELL_MODULE_EXECUTED')\n",
      )
      const sourceNames = [...modules, 'undeclared-entry.ts', 'undeclared.ts']
      for (const module of sourceNames) {
        await chmod(join(sources, module), 0o444)
        await symlink(join(sources, module), join(rulesSources, module))
        expect(await readlink(join(rulesSources, module))).toBe(join(sources, module))
      }
      await writeFile(
        join(rules, 'BUCK'),
        `load("@rules//buck2:materialization.bzl", "runtime_modules")\n${runtime}\n\n${runtime
          .replace('name = "package_tree_runtime"', 'name = "undeclared_runtime"')
          .replace('"src/package-tree.ts"', '"src/undeclared-entry.ts"')}\n`,
      )
      await writeFile(join(root, 'package.json'), '{"name":"runtime-source-closure-fixture"}\n')
      await writeFile(
        join(root, 'BUCK'),
        `load("@rules//buck2:materialization.bzl", "empty_package_view")
empty_package_view(
    name = "declared",
    files = {"package.json": "package.json"},
    runtime = "runtime_rules//:package_tree_runtime",
    runtime_entry = "package-tree.ts",
)
empty_package_view(
    name = "undeclared",
    files = {"package.json": "package.json"},
    runtime = "runtime_rules//:undeclared_runtime",
    runtime_entry = "package-tree.ts",
)
`,
      )
      const cellConfig = join(fixture.root, 'cells.buckconfig')
      await writeFile(
        cellConfig,
        `[cells]\n  fixture = ${relative(tools.repoRoot, root)}\n  runtime_rules = ${relative(tools.repoRoot, rules)}\n`,
      )
      await chmod(join(rules, 'BUCK'), 0o444)
      for (const directory of [sources, rulesSources, rules]) await chmod(directory, 0o555)
      // An owned overlay leaves the production root config untouched. An isolated
      // daemon owns the fixture; cleanup must never kill the repository daemon.
      const isolation = `runtime-source-closure-${process.pid}`
      const buckArgs = ['--isolation-dir', isolation]
      const buildArgs = [
        ...buckArgs,
        'build',
        '--config-file',
        cellConfig,
        '--config',
        'buck2.remote_cache_enabled=false',
        '--config',
        'buck2.file_watcher=fs_hash_crawler',
        '--target-platforms',
        'effect_utils//buck2/platforms:host_platform',
        '--show-full-json-output',
      ]
      try {
        const positive = await runCaptured(
          buck,
          [...buildArgs, 'fixture//:declared', 'runtime_rules//:package_tree_runtime'],
          tools,
          fixture,
          process.env,
        )
        assert.equal(positive.status, 0, positive.stderr)
        const outputs: Record<string, string> = JSON.parse(positive.stdout)
        const tree = outputs['fixture//:declared']
        const staged = outputs['runtime_rules//:package_tree_runtime']
        assert(tree !== undefined && staged !== undefined, positive.stdout)
        expect(JSON.parse(await readFile(join(tree, 'package.json'), 'utf8'))).toEqual({
          name: 'runtime-source-closure-fixture',
        })
        for (const module of modules) {
          expect((await lstat(join(staged, module))).isFile()).toBe(true)
          expect(await readFile(join(staged, module), 'utf8')).toBe(
            await readFile(join(sources, module), 'utf8'),
          )
        }
        const negative = await runCaptured(
          buck,
          [...buildArgs, 'fixture//:undeclared'],
          tools,
          fixture,
          process.env,
        )
        expect(negative.status).not.toBe(0)
        expect(negative.stderr).toContain('undeclared.ts')
        expect(negative.stderr).not.toContain('UNDECLARED_RULES_CELL_MODULE_EXECUTED')
      } finally {
        const stopped = await runCaptured(buck, [...buckArgs, 'kill'], tools, fixture, process.env)
        for (const directory of [sources, rulesSources, rules]) await chmod(directory, 0o755)
        assert.equal(stopped.status, 0, stopped.stderr)
        await rm(join(tools.repoRoot, 'buck-out', isolation), { recursive: true, force: true })
      }
    })
  }, 120_000)

  it('passes the production negative probes and preserves hidden host siblings outside the output directory', async () => {
    await withFixture(tools, async (fixture) => {
      const sibling = join(fixture.root, 'host-output-sibling')
      await writeFile(sibling, 'host output sibling must remain unchanged')
      const result = await runLauncher(tools, fixture)
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      await expectProbeReceipt(fixture)
      expect(await readFile(sibling, 'utf8')).toBe('host output sibling must remain unchanged')
      await expect(access(join(fixture.root, 'ts-sandbox-forbidden-write'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  }, 20_000)

  it('fails closed when the declared Bubblewrap executable is missing', async () => {
    await withFixture(tools, async (fixture) => {
      const missingBubblewrap = join(fixture.root, 'missing-bwrap')
      const source = await readFile(fixture.launcher, 'utf8')
      await writeFile(fixture.launcher, source.replaceAll(tools.bubblewrap, missingBubblewrap))
      const result = await runLauncher(tools, fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(missingBubblewrap)
      expect((await stat(fixture.outputDirectory)).isDirectory()).toBe(true)
      await expect(access(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('fails closed when the declared Bun runtime is missing instead of using ambient Bun', async () => {
    await withFixture(tools, async (fixture) => {
      const missingBun = '/missing-declared-bun'
      const source = await readFile(fixture.launcher, 'utf8')
      await writeFile(fixture.launcher, source.replaceAll(tools.bun, missingBun))
      const result = await runLauncher(tools, fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(missingBun)
      await expect(access(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('propagates a real Bubblewrap namespace failure without running the action or falling back', async () => {
    await withFixture(tools, async (fixture) => {
      // The real outer Bubblewrap disables nested user namespaces. The inner
      // generated launcher must fail its mandatory production --unshare-all.
      // This broad bind belongs only to the trusted harness, never to an action.
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
          tools.repoRoot,
          '--',
          tools.bash,
          '--noprofile',
          '--norc',
          fixture.launcher,
        ],
        tools,
        fixture,
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/bwrap:.*(?:namespace|userns)/i)
      // Only the inner generated script creates this directory. Its presence
      // proves the outer harness started rather than failing before the launcher.
      expect((await stat(fixture.outputDirectory)).isDirectory()).toBe(true)
      await expect(access(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  }, 20_000)
})
