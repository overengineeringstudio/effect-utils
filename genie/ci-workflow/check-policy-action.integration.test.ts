import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

// Explicit real-Nix smoke lane, separate from bootstrap-safe fixture tests.
// Run on a fleet runner: bun test ./genie/ci-workflow/check-policy-action.integration.test.ts
const root = new URL('../../', import.meta.url).pathname

test('real action ignores consumer runtime options, PATH executables and Nix configuration', async () => {
  await mkdir(join(root, 'tmp/ci-policy-action'), { recursive: true })
  const fixture = await mkdtemp(join(root, 'tmp/ci-policy-action/consumer-'))
  try {
    const marker = join(fixture, 'consumer-code-executed')
    await mkdir(join(fixture, '.github/workflows'), { recursive: true })
    await mkdir(join(fixture, 'bin'))
    await mkdir(join(fixture, 'runner-temp'))
    await Bun.write(
      join(fixture, 'preload.ts'),
      `await Bun.write(${JSON.stringify(marker)}, 'preload'); process.exit(0)\n`,
    )
    await Bun.write(join(fixture, 'bunfig.toml'), 'preload = ["./preload.ts"]\n')
    const fakeNix = join(fixture, 'bin/nix')
    await Bun.write(
      fakeNix,
      `#!/bin/sh\nprintf consumer-nix > '${marker}'\nprintf 'consumer/nix#bypass\\n'\nexit 0\n`,
    )
    await Bun.$`chmod +x ${fakeNix}`
    const userConfig = join(fixture, 'nix.conf')
    await Bun.write(userConfig, `plugin-files = ${fixture}/untrusted-plugin.so\n`)
    const action = Bun.YAML.parse(
      await Bun.file(join(root, '.github/actions/ci-policy/action.yml')).text(),
    )
    for (const [runner, exitCode] of [
      ['[sh-linux-x64, nix]', 0],
      ['ubuntu-latest', 1],
    ] as const) {
      await Bun.write(
        join(fixture, '.github/workflows/ci.yml'),
        `on: push\njobs:\n  check:\n    runs-on: ${runner}\n    if: true\n    steps:\n      - run: echo compliant\n`,
      )
      const process = Bun.spawn(
        ['/run/current-system/sw/bin/bash', '-c', action.runs.steps[0].run],
        {
          cwd: fixture,
          env: {
            ...Bun.env,
            GITHUB_WORKSPACE: fixture,
            RUNNER_TEMP: join(fixture, 'runner-temp'),
            CI_POLICY_ACTION_PATH: join(root, '.github/actions/ci-policy'),
            CI_POLICY_ROOT: '.',
            CI_POLICY_EXCEPTIONS: '',
            CI_POLICY_REPOSITORY: 'example/consumer',
            PATH: `${join(fixture, 'bin')}:${Bun.env.PATH}`,
            BUN_OPTIONS: `--preload=${join(fixture, 'preload.ts')}`,
            NODE_OPTIONS: `--require=${join(fixture, 'preload.ts')}`,
            NIX_CONFIG: `plugin-files = ${fixture}/untrusted-plugin.so`,
            NIX_USER_CONF_FILES: userConfig,
            NIX_CONF_DIR: fixture,
            NIX_PATH: `nixpkgs=${fixture}`,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [actualExitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ])
      expect(actualExitCode, stdout + stderr).toBe(exitCode)
      expect(await Bun.file(marker).exists()).toBe(false)
      if (exitCode === 0) expect(stdout).toContain('CI workflow fleet policy passed')
      else expect(stderr).toContain('hosted-runner')
    }
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
}, 180_000)
