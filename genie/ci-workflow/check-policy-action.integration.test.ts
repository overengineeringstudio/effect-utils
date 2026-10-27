import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

// Real-Nix isolation lane, separate from bootstrap-safe fixture tests.
// CI: quality (pr/quality), "CI policy action isolation smoke" step.
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
    const startup = join(fixture, 'bash-startup.sh')
    await Bun.write(startup, `printf startup > '${marker}'\nexit 0\n`)
    const fakeBash = join(fixture, 'bin/bash')
    await Bun.write(fakeBash, `#!/bin/sh\nprintf consumer-bash > '${marker}'\nexit 0\n`)
    await Bun.$`chmod +x ${fakeBash}`
    const action = Bun.YAML.parse(
      await Bun.file(join(root, '.github/actions/ci-policy/action.yml')).text(),
    )
    const loaderControls = [
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'LD_AUDIT',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
      'DYLD_FRAMEWORK_PATH',
    ] as const
    for (const name of loaderControls) expect(action.runs.steps[0].env[name]).toBe('')
    const loaderOverrides = Object.fromEntries(
      loaderControls.map((name) => [name, action.runs.steps[0].env[name]]),
    )
    const nix = (await Bun.file('/nix/var/nix/profiles/default/bin/nix').exists())
      ? '/nix/var/nix/profiles/default/bin/nix'
      : '/run/current-system/sw/bin/nix'
    const packageSelector = join(root, '.github/actions/ci-policy/bun-package.nix')
    const bunPackage = (
      await Bun.$`${nix} eval --impure --raw --file ${packageSelector}`.text()
    ).trim()
    const compilerPackage = bunPackage.replace(/#bun$/, '#stdenv.cc')
    const library = join(fixture, 'loader-injection.so')
    const source = join(fixture, 'loader-injection.c')
    await Bun.write(
      source,
      `
      #include <fcntl.h>
      #include <stdlib.h>
      #include <unistd.h>
      __attribute__((constructor)) static void inject(void) {
        const char *marker = getenv("CI_POLICY_LOADER_MARKER");
        if (marker) {
          int fd = open(marker, O_WRONLY | O_CREAT | O_TRUNC, 0600);
          if (fd >= 0) { write(fd, "loader", 6); close(fd); }
        }
        _exit(0);
      }
    `,
    )
    await Bun.$`${nix} shell --option builders ${''} --option max-jobs 0 ${compilerPackage} --command cc -shared -fPIC -o ${library} ${source}`.quiet()
    // Prove the fixture can bypass a native launcher before env -i executes.
    const vulnerable = Bun.spawnSync(['/usr/bin/env', '-i', '/bin/sh', '-c', 'exit 42'], {
      env: { ...Bun.env, LD_PRELOAD: library, CI_POLICY_LOADER_MARKER: marker },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(vulnerable.exitCode, vulnerable.stderr.toString()).toBe(0)
    expect(await Bun.file(marker).text()).toBe('loader')
    await rm(marker)
    const script = join(fixture, 'action-step.sh')
    await Bun.write(script, action.runs.steps[0].run)
    // Match the runner's custom-shell argv boundary, including its script argument.
    const shellArgs: string[] = action.runs.steps[0].shell
      .split(' ')
      .map((argument: string) => (argument === '{0}' ? script : argument))
    for (const [runner, exitCode] of [
      ['[sh-linux-x64, nix]', 0],
      ['ubuntu-latest', 1],
    ] as const) {
      await Bun.write(
        join(fixture, '.github/workflows/ci.yml'),
        `on: push\njobs:\n  check:\n    runs-on: ${runner}\n    if: true\n    steps:\n      - run: echo compliant\n`,
      )
      const process = Bun.spawn(shellArgs, {
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
          BASH_ENV: startup,
          ENV: startup,
          'BASH_FUNC_realpath%%': `() { printf function > '${marker}'; exit 0; }`,
          'BASH_FUNC_env%%': `() { printf function > '${marker}'; exit 0; }`,
          LD_PRELOAD: library,
          LD_LIBRARY_PATH: fixture,
          LD_AUDIT: library,
          DYLD_INSERT_LIBRARIES: library,
          DYLD_LIBRARY_PATH: fixture,
          DYLD_FRAMEWORK_PATH: fixture,
          CI_POLICY_LOADER_MARKER: marker,
          // GitHub overlays step env before creating the custom-shell process.
          ...loaderOverrides,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
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
