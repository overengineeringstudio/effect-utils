import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { createServer, type ServerHttp2Stream } from 'node:http2'
import { getPriority, homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer as createTlsServer } from 'node:tls'

import type { CacheAdmissionInvocation } from '../genie/ci-scripts/buck2-cache-evidence.ts'
import * as daemonPostureTests from './buck2-entrypoint.posture.integration.test.ts'
import {
  type AdmissionProbeEndpoint,
  directBuckArguments,
  nativeBuildIdArguments,
} from './buck2-entrypoint.ts'
import * as gateUnitTests from './buck2-entrypoint.unit.test.ts'
import * as gateIsolationTests from './buck2-gate-isolation.integration.test.ts'
import * as gateTeardownTests from './buck2-gate-teardown.integration.test.ts'

// Register the lifecycle suites in the existing devenv test entrypoint.
void [gateUnitTests, gateTeardownTests, gateIsolationTests, daemonPostureTests]

const roots: string[] = []
const launchProcesses = new Set<{ readonly pid: number; readonly exited: Promise<number> }>()
const fixture = (address = 'grpc://127.0.0.1:1', archive = 'http://127.0.0.1:1/cas/'): string => {
  const root = mkdtempSync(join(tmpdir(), 'direct-buck-posture-'))
  roots.push(root)
  writeFileSync(join(root, '.buckroot'), '')
  writeFileSync(
    join(root, '.buckconfig'),
    `[buck2]\nremote_cache_enabled = true\nallow_cache_uploads = false\n[buck2_re_client]\naction_cache_address = ${address}\ninstance_name = fixture\ntls = false\n[archive_origin]\ntrusted_url_prefix = ${archive}\ntrusted_tier = private\n`,
  )
  return root
}
// Fixture service outcomes are controlled by its script, not host scheduling.
// The unchanged Bun guard bounds these real child queries.
const fixtureProbeDeadlineSignal = (endpoint: AdmissionProbeEndpoint) =>
  endpoint === 'watchman' ? new AbortController().signal : undefined
const options = (root: string) => ({
  cwd: root,
  env: {},
  cacheDirectory: join(root, 'probe-cache'),
  probeDeadlineSignal: fixtureProbeDeadlineSignal,
})

const watcherFixture = () => {
  const root = realpathSync(fixture())
  writeFileSync(join(root, '.buckconfig'), '[buck2]\nfile_watcher = watchman\n')
  const state = join(root, 'socket')
  const calls = join(root, 'watchman-calls')
  writeFileSync(state, 'healthy')
  writeFileSync(
    join(root, 'watchman'),
    `#!${Bun.which('sh')}
printf '%s\\n' "$*" >> '${calls}'
if [ "$1" = "--version" ]; then
  printf '2026.10.05\\n'
  exit 0
fi
if [ "$1" = "--no-spawn" ]; then shift; fi
# Like Watchman, client-local commands are healthy even with no reachable
# service; get-sockname reports the computed socket without connecting.
if [ "$1" != "--no-local" ]; then
  case " $* " in
    *" get-sockname "*) printf '{"version":"2026.10.05","sockname":"${state}"}\n' ;;
    *) printf '{"version":"2026.10.05"}\n' ;;
  esac
  exit 0
fi
shift
# WATCHMAN_SOCK itself is deliberately ignored: only --sockname selects a service.
socket='${state}'
case "$1" in
  --sockname=*) socket="\${1#--sockname=}"; shift ;;
esac
[ "$*" = "--output-encoding=json watch-project ${root}" ] || exit 2
# The real client exits silently when --no-spawn finds no reachable service.
status=''
if [ -f "$socket" ]; then IFS= read -r status < "$socket" || :; fi
case "$status" in
  healthy) printf '{"version":"2026.10.05","watch":"${root}"}\n' ;;
  unreachable) printf 'unable to connect to service\n' >&2; exit 1 ;;
  nice-refusal) printf 'Watchman is running at a lower than normal priority. (nice_value=19, min_acceptable_nice_value=0). Watchman is refusing to start.\n' >&2; exit 1 ;;
  malformed) printf 'not json\n' ;;
  error) printf '{"version":"2026.10.05","error":"service unavailable"}\n' ;;
  wrong-type) printf '{"version":123,"watch":"${root}"}\n' ;;
  missing-version) printf '{"watch":"${root}"}\n' ;;
  missing-root) printf '{"version":"2026.10.05"}\n' ;;
  wrong-root) printf '{"version":"2026.10.05","watch":"${dirname(root)}","relative_path":"fixture"}\n' ;;
  relative-root) printf '{"version":"2026.10.05","watch":"${root}","relative_path":"ignored"}\n' ;;
  retry-timeout)
    count=0
    while IFS= read -r call; do count=$((count + 1)); done < '${calls}'
    if [ "$count" -eq 1 ]; then exec sleep 30; fi
    printf '{"version":"2026.10.05","watch":"${root}"}\n' ;;
  hanging) exec sleep 30 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o700 },
  )
  return {
    root,
    state,
    calls,
    env: {
      PATH: `${root}:${process.env['PATH'] ?? ''}`,
      HOME: root,
      WATCHMAN_SOCK: join(root, 'socket'),
    },
  }
}
type PreparedEntrypoint = {
  readonly child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  readonly stdout: Promise<string>
}

const prepareEntrypointProcess = async ({
  root,
  env,
  args,
}: {
  readonly root: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly args: readonly string[]
}) => {
  const preload = join(root, 'prepare-entrypoint.ts')
  if (existsSync(preload) === false) {
    // Preload the real dependencies, not the entrypoint itself: import.meta.main
    // must still run the actual CLI after the test releases this startup barrier.
    writeFileSync(
      preload,
      `import ${JSON.stringify(join(import.meta.dir, 'buck2-cache-posture.ts'))};
import ${JSON.stringify(join(import.meta.dir, 'buck2-file-watcher.ts'))};
process.stdout.write('entrypoint-ready\\n');
await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
`,
    )
  }
  const child = Bun.spawn([process.execPath, '--preload', preload, ...args], {
    cwd: root,
    env: { ...env, BUCK2_STDIO_LIBRARY: process.env['BUCK2_STDIO_LIBRARY'] },
    detached: true,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  launchProcesses.add(child)
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let ready = ''
  try {
    while (ready.endsWith('\n') === false) {
      const { value, done } = await reader.read()
      if (done === true) throw new Error('entrypoint process exited before startup readiness')
      ready += decoder.decode(value, { stream: true })
    }
    expect(ready).toBe('entrypoint-ready\n')
  } catch (error) {
    reader.releaseLock()
    throw error
  }
  // Keep one reader through EOF. A stream that has supplied readiness is
  // disturbed even after releaseLock(), so it cannot become a Response body.
  const stdout = (async () => {
    let text = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done === true) return text + decoder.decode()
        text += decoder.decode(value, { stream: true })
      }
    } finally {
      reader.releaseLock()
    }
  })()
  return { child, stdout }
}
const watcherLocal = (root: string): string =>
  existsSync(join(root, '.buckconfig.local')) === true
    ? readFileSync(join(root, '.buckconfig.local'), 'utf8')
    : ''
const effective = (args: readonly string[]): Record<string, string> => {
  const values: Record<string, string> = {}
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--') break
    if (args[index] === '-c' || args[index] === '--config') {
      const value = args[++index] ?? ''
      const equals = value.indexOf('=')
      values[value.slice(0, equals)] = value.slice(equals + 1)
    }
  }
  return values
}
afterEach(async () => {
  for (const child of launchProcesses) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
    // Descendants are not awaitable children; poll the real OS group condition,
    // not a guessed grace period, before deleting their fixtures.
    await child.exited
    const deadline = performance.now() + 2000
    for (;;) {
      try {
        process.kill(-child.pid, 0)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') break
        throw error
      }
      if (performance.now() >= deadline)
        throw new Error(`Launch process group ${child.pid} was not reaped; preserving fixtures`)
      await Bun.sleep(10)
    }
  }
  launchProcesses.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('native build ID registry', () => {
  const buildId = '00112233-4455-4677-8899-aabbccddeeff'

  it('fails closed when the native-start registry cannot be persisted', () => {
    const root = fixture()
    const blocked = join(root, 'not-a-directory')
    writeFileSync(blocked, '')
    expect(() =>
      nativeBuildIdArguments({
        args: ['build', '//:app'],
        cwd: root,
        env: {
          CI_BUCK2_CACHE_EVIDENCE_PATH: join(blocked, 'evidence.json'),
          BUCK_WRAPPER_UUID: buildId,
        },
      }),
    ).toThrow()
  })

  it('does not register or start a denied cache writer', async () => {
    const root = fixture()
    const evidence = join(root, 'evidence.json')
    const started = join(root, 'native-started')
    const native = join(root, 'denied-native')
    writeFileSync(native, `#!/bin/sh\nprintf started > ${JSON.stringify(started)}\n`, {
      mode: 0o700,
    })
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'buck2-entrypoint.ts'), native, 'build', '//:app'],
      {
        cwd: root,
        env: {
          PATH: process.env['PATH'],
          HOME: root,
          BUCK_WRAPPER_UUID: buildId,
          BUCK2_CACHE_WRITE_BASIC_AUTH: 'fixture-secret',
          CI_BUCK2_CACHE_EVIDENCE_PATH: evidence,
          BUCK2_STDIO_LIBRARY: process.env['BUCK2_STDIO_LIBRARY'],
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain('refusing to publish')
    expect(existsSync(started)).toBe(false)
    expect(existsSync(`${evidence}.native-build-id-paths.jsonl`)).toBe(false)
    expect(existsSync(`${evidence}.native-build-ids`)).toBe(false)
  })

  it('registers native output paths without claiming native startup or writing the ID', async () => {
    const root = fixture()
    const evidence = join(root, 'evidence.json')
    const env = {
      CI_BUCK2_CACHE_EVIDENCE_PATH: evidence,
      BUCK_WRAPPER_UUID: buildId.replaceAll('-', '').toUpperCase(),
      BUCK2_NO_REMOTE_CACHE: '1',
    }
    const args = await directBuckArguments({
      ...options(root),
      env,
      args: ['run', '//:app', '--', '--write-build-id=application-argument'],
    })
    const result = nativeBuildIdArguments({ args, cwd: root, env })
    const path = `${evidence}.native-build-ids/${buildId}.buck-trace-id`
    expect(result.slice(-4)).toEqual([
      '--write-build-id',
      path,
      '--',
      '--write-build-id=application-argument',
    ])
    expect(readFileSync(`${evidence}.native-build-id-paths.jsonl`, 'utf8')).toBe(
      `${JSON.stringify({ buildId, path })}\n`,
    )
    expect(existsSync(path)).toBe(false)
  })

  for (const flag of [['--write-build-id', 'caller.id'], ['--write-build-id=caller.id']]) {
    it(`preserves caller native output arguments (${flag.join(' ')})`, () => {
      const root = fixture()
      const evidence = join(root, 'evidence.json')
      const args = ['build', '//:app', ...flag]
      expect(
        nativeBuildIdArguments({
          args,
          cwd: root,
          env: { CI_BUCK2_CACHE_EVIDENCE_PATH: evidence, BUCK_WRAPPER_UUID: buildId },
        }),
      ).toEqual(args)
      expect(JSON.parse(readFileSync(`${evidence}.native-build-id-paths.jsonl`, 'utf8'))).toEqual({
        buildId,
        path: join(root, 'caller.id'),
      })
      expect(existsSync(join(root, 'caller.id'))).toBe(false)
    })
  }

  it('does not register rootless, non-config, help or disabled-evidence invocations', () => {
    const root = fixture()
    const rootless = mkdtempSync(join(tmpdir(), 'buck-rootless-'))
    roots.push(rootless)
    const evidence = join(root, 'evidence.json')
    for (const invocation of [
      { cwd: rootless, args: ['build', '//:app'] },
      { cwd: root, args: ['log', 'show'] },
      { cwd: root, args: ['build', '--help'] },
      { cwd: root, args: ['--', 'build'] },
      { cwd: root, args: ['build', '--write-build-id'] },
      { cwd: root, args: ['build', '--write-build-id='] },
    ]) {
      expect(
        nativeBuildIdArguments({
          ...invocation,
          env: { CI_BUCK2_CACHE_EVIDENCE_PATH: evidence, BUCK_WRAPPER_UUID: buildId },
        }),
      ).toEqual(invocation.args)
    }
    expect(nativeBuildIdArguments({ args: ['build'], cwd: root, env: {} })).toEqual(['build'])
    expect(existsSync(`${evidence}.native-build-id-paths.jsonl`)).toBe(false)
  })

  it('lets native startup produce the registered canonical build ID', async () => {
    const root = fixture()
    const evidence = join(root, 'evidence.json')
    const native = join(root, 'native-build-id')
    writeFileSync(
      native,
      `#!${process.execPath}
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const path = args[args.indexOf('--write-build-id') + 1]
writeFileSync(path, process.env.BUCK_WRAPPER_UUID + '\\n')
`,
      { mode: 0o700 },
    )
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'buck2-entrypoint.ts'), native, 'build', '//:app'],
      {
        cwd: root,
        env: {
          PATH: process.env['PATH'],
          HOME: root,
          BUCK2_NO_REMOTE_CACHE: '1',
          BUCK_WRAPPER_UUID: buildId,
          CI_BUCK2_CACHE_EVIDENCE_PATH: evidence,
          BUCK2_STDIO_LIBRARY: process.env['BUCK2_STDIO_LIBRARY'],
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect({
      code: await child.exited,
      stderr: await new Response(child.stderr).text(),
    }).toMatchObject({ code: 0 })
    const row = JSON.parse(readFileSync(`${evidence}.native-build-id-paths.jsonl`, 'utf8'))
    expect(row.buildId).toBe(buildId)
    expect(readFileSync(row.path, 'utf8').trim()).toBe(buildId)
  })
})

describe('direct pinned Buck posture', () => {
  for (const mode of ['source', 'compiled', 'missing-shim'] as const) {
    it(`preserves inherited stdio flags and complete large stderr after a launcher diagnostic (${mode})`, async () => {
      const root = fixture()
      const baseline = join(root, 'stdio-before.json')
      const observed = join(root, 'stdio-after.json')
      const childPath = join(root, 'native-stderr.ts')
      const launcher = join(import.meta.dir, 'buck2-entrypoint.ts')
      const library = process.env['BUCK2_STDIO_LIBRARY']
      expect(library).toBeDefined()
      const executable = mode === 'source' ? process.execPath : join(root, 'compiled-launcher')
      const launcherArgs = mode === 'source' ? [launcher] : []
      if (mode !== 'source') {
        const build = Bun.spawnSync(
          [
            process.execPath,
            'build',
            '--compile',
            launcher,
            '--define',
            `BUCK2_STDIO_LIBRARY=${JSON.stringify(mode === 'missing-shim' ? join(root, 'absent-shim') : library)}`,
            '--outfile',
            executable,
          ],
          { cwd: root, stdout: 'pipe', stderr: 'pipe' },
        )
        expect({ code: build.exitCode, stderr: build.stderr.toString() }).toMatchObject({ code: 0 })
      }
      const nativeFlags = `
import { dlopen } from 'bun:ffi'
import { writeFileSync, writeSync } from 'node:fs'
const stdio = dlopen(${JSON.stringify(library)}, {
  eu_getfl: { args: ['i32'], returns: 'i32' },
  eu_setfl: { args: ['i32', 'i32'], returns: 'i32' },
})
const flags = () => [0, 1, 2].map((fd) => stdio.symbols.eu_getfl(fd))
`
      const payloadSize = 2 * 1024 * 1024
      writeFileSync(
        childPath,
        `#!${process.execPath}
${nativeFlags}
writeFileSync(${JSON.stringify(observed)}, JSON.stringify(flags()))
const payload = Buffer.alloc(${payloadSize}, 'x')
let offset = 0
while (offset < payload.length) offset += writeSync(2, payload, offset, payload.length - offset)
writeSync(2, '\\nlarge-stderr-complete\\n')
`,
        { mode: 0o700 },
      )
      // Establish genuinely blocking inherited descriptors independently of the
      // test runner's stream implementation, then exec the real launcher.
      const child = Bun.spawn(
        [
          process.execPath,
          '-e',
          `${nativeFlags}
const nonblock = process.platform === 'darwin' ? 4 : 2048
for (const [fd, value] of flags().entries()) {
  if (value < 0 || stdio.symbols.eu_setfl(fd, value & ~nonblock) !== 0) process.exit(70)
}
writeFileSync(${JSON.stringify(baseline)}, JSON.stringify(flags()))
// Exercise the native ABI with an actual flag transition, not a no-op restore.
const blocking = flags()
for (const [fd, value] of blocking.entries()) {
  if (stdio.symbols.eu_setfl(fd, value | nonblock) !== 0) process.exit(71)
  if (stdio.symbols.eu_getfl(fd) !== (value | nonblock)) process.exit(72)
  if (stdio.symbols.eu_setfl(fd, value) !== 0 || stdio.symbols.eu_getfl(fd) !== value) process.exit(73)
}
process.execve(${JSON.stringify(executable)}, [${JSON.stringify(executable)}, ...${JSON.stringify(launcherArgs)}, ${JSON.stringify(childPath)}, 'build', '//:app'], process.env)
`,
        ],
        {
          cwd: root,
          env: {
            PATH: process.env['PATH'],
            HOME: root,
            XDG_CACHE_HOME: join(root, 'cache'),
            BUCK2_STDIO_LIBRARY: library,
          },
          detached: true,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      launchProcesses.add(child)
      const reader = child.stderr.getReader()
      const chunks: Uint8Array[] = []
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done === true) break
          chunks.push(value)
          // Deliberately apply backpressure rather than buffering the entire
          // stream in a fast Response reader.
          await Bun.sleep(5)
        }
      } finally {
        reader.releaseLock()
      }
      const stderr = Buffer.concat(chunks).toString()
      expect(stderr).toContain('warning: Buck2 REAPI probe failed:')
      if (mode === 'missing-shim') {
        expect(stderr.split('warning: Buck2 stdio flag protection unavailable:')).toHaveLength(2)
      } else {
        expect(stderr.includes('warning: Buck2 stdio flag')).toBe(false)
      }
      // Darwin F_GETFL also exposes kernel FWASWRITTEN bookkeeping after the
      // warning. It is not a status option and cannot be cleared by F_SETFL.
      const statusMask = process.platform === 'darwin' ? ~0x10000 : -1
      expect(
        JSON.parse(readFileSync(observed, 'utf8')).map((value: number) => value & statusMask),
      ).toEqual(
        JSON.parse(readFileSync(baseline, 'utf8')).map((value: number) => value & statusMask),
      )
      expect(await child.exited).toBe(0)
      expect(stderr.endsWith(`${'x'.repeat(payloadSize)}\nlarge-stderr-complete\n`)).toBe(true)
    }, 20000)
  }

  for (const scenario of ['unwritable-stderr', 'restore-failure'] as const) {
    it(`still execs with complete child output after stdio protection ${scenario}`, async () => {
      const root = fixture()
      const launcher = join(import.meta.dir, 'buck2-entrypoint.ts')
      const native = join(root, 'native-stdout.ts')
      const payloadSize = 256 * 1024
      writeFileSync(
        native,
        `#!${process.execPath}
import { writeSync } from 'node:fs'
const payload = Buffer.alloc(${payloadSize}, 'y')
let offset = 0
while (offset < payload.length) offset += writeSync(1, payload, offset, payload.length - offset)
writeSync(1, '\\nchild-executed\\n')
`,
        { mode: 0o700 },
      )
      let command: string[]
      if (scenario === 'unwritable-stderr') {
        const executable = join(root, 'missing-protection-launcher')
        const build = Bun.spawnSync(
          [
            process.execPath,
            'build',
            '--compile',
            launcher,
            '--define',
            `BUCK2_STDIO_LIBRARY=${JSON.stringify(join(root, 'absent-shim'))}`,
            '--outfile',
            executable,
          ],
          { cwd: root, stdout: 'pipe', stderr: 'pipe' },
        )
        expect({ code: build.exitCode, stderr: build.stderr.toString() }).toMatchObject({ code: 0 })
        command = [
          process.execPath,
          '-e',
          `import { closeSync, openSync } from 'node:fs'
// Bun itself cannot exec with a closed fd2, even without a launcher. Keep
// fd2 present but read-only so the optional warning genuinely gets EBADF.
closeSync(2)
if (openSync('/dev/null', 'r') !== 2) process.exit(71)
process.execve(${JSON.stringify(executable)}, [${JSON.stringify(executable)}, ${JSON.stringify(native)}, '--version'], process.env)`,
        ]
      } else {
        const preload = join(root, 'inject-restore-failure.ts')
        // Force a real EBADF during restoration, then reopen stdin only at the
        // actual exec call: Bun itself rejects closed stdio before execve.
        writeFileSync(
          preload,
          `import { closeSync, openSync } from 'node:fs'
import process from 'node:process'
const execve = process.execve
const forwardExecve = (file: string, args: string[], env: Record<string, string>) => {
  if (openSync('/dev/null', 'r') !== 0) process.exit(73)
  return execve(file, args, env)
}
let injected = false
Object.defineProperty(process, 'execve', {
  get() {
    if (injected === false) {
      closeSync(0)
      injected = true
    }
    return forwardExecve
  },
})
`,
        )
        command = [process.execPath, '--preload', preload, launcher, native, '--version']
      }
      const child = Bun.spawn(command, {
        cwd: root,
        env: {
          PATH: process.env['PATH'],
          HOME: root,
          BUCK2_STDIO_LIBRARY: process.env['BUCK2_STDIO_LIBRARY'],
        },
        detached: true,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      launchProcesses.add(child)
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code).toBe(0)
      expect(stdout).toBe(`${'y'.repeat(payloadSize)}\nchild-executed\n`)
      if (scenario === 'restore-failure') {
        expect(stderr.split('warning: Buck2 stdio flag restoration failed:')).toHaveLength(2)
        expect(stderr).not.toContain('warning: Buck2 stdio flag protection unavailable:')
      } else {
        expect(stderr).toBe('')
      }
    }, 20000)
  }

  for (const scenario of ['healthy', 'retry-success', 'both-fail'] as const) {
    it(`records per-invocation cache admission for ${scenario}`, async () => {
      let requests = 0
      let archiveRequests = 0
      const deadlines: string[] = []
      const probeDeadlines: Record<'reapi', AbortController[]> = { reapi: [] }
      const grpc = createServer()
      grpc.on('stream', (stream: ServerHttp2Stream, headers) => {
        requests++
        deadlines.push(String(headers['grpc-timeout']))
        stream.on('error', () => {})
        stream.on('data', () => {})
        stream.on('end', () => {
          if (scenario === 'both-fail' || (scenario === 'retry-success' && requests === 1)) {
            const deadline = probeDeadlines.reapi[requests - 1]
            if (deadline === undefined) throw new Error('expected REAPI attempt deadline')
            deadline.abort()
            return
          }
          stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' })
          stream.end(Buffer.from([0, 0, 0, 0, 0]))
        })
      })
      grpc.listen(0, '127.0.0.1')
      await new Promise<void>((resolve) => grpc.once('listening', resolve))
      const bound = grpc.address()
      if (bound === null || typeof bound === 'string') throw new Error('expected TCP listener')
      const archive = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: () => {
          archiveRequests++
          return new Response(null, { status: 404 })
        },
      })
      try {
        const root = fixture(
          `grpc://127.0.0.1:${bound.port}`,
          `http://127.0.0.1:${archive.port}/cas/`,
        )
        const evidence = join(root, 'evidence.json')
        const admissionOptions = {
          ...options(root),
          args: ['build', '//:app'],
          env: { CI_BUCK2_CACHE_EVIDENCE_PATH: evidence, GITHUB_ACTIONS: 'true' },
          ...(scenario === 'healthy' ? {} : { deadlineMs: 100 }),
          // The fixture expires only deliberately held attempts, after receiving
          // the real request. A healthy retry must not race a wall-clock timer.
          probeDeadlineSignal: (endpoint: AdmissionProbeEndpoint) => {
            if (endpoint === 'watchman') return undefined
            const deadline = new AbortController()
            probeDeadlines[endpoint].push(deadline)
            return deadline.signal
          },
        }
        const invocationId = '01234567-89ab-cdef-0123-456789abcdef'
        const result = await directBuckArguments({
          ...admissionOptions,
          env: { ...admissionOptions.env, BUCK_WRAPPER_UUID: invocationId.replaceAll('-', '') },
        })
        if (scenario === 'both-fail')
          expect(effective(result)['buck2.remote_cache_enabled']).toBe('false')
        else expect(effective(result)['buck2.remote_cache_enabled']).not.toBe('false')
        expect(effective(result)['archive_origin.url_prefix']).toBeUndefined()
        expect(requests).toBe(scenario === 'healthy' ? 1 : 2)
        expect(archiveRequests).toBe(0)
        expect(deadlines).toEqual(scenario === 'healthy' ? ['2500m'] : ['100m', '100m'])
        for (const attempts of Object.values(probeDeadlines)) {
          expect(attempts.map((deadline) => deadline.signal.aborted)).toEqual(
            scenario === 'healthy'
              ? [false]
              : scenario === 'retry-success'
                ? [true, false]
                : [true, true],
          )
        }
        if (scenario === 'both-fail') {
          await expect(
            directBuckArguments({
              ...admissionOptions,
              env: { ...admissionOptions.env, BUCK2_CACHE_WRITE_BASIC_AUTH: 'fixture-secret' },
            }),
          ).rejects.toThrow('refusing to publish without remote cache')
        } else {
          // A hot-loop cache hit is its own healthy invocation, not a second recovered retry.
          await directBuckArguments(admissionOptions)
        }
        const rows = readFileSync(`${evidence}.admission.jsonl`, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as CacheAdmissionInvocation)
        expect(rows).toHaveLength(2)
        expect(new Set(rows.map((row) => row.invocationId)).size).toBe(2)
        expect(rows[0]?.invocationId).toBe(invocationId)
        for (const [index, row] of rows.entries()) {
          expect(row.admissionFallbacks).toEqual({
            reapi: scenario === 'both-fail' ? 1 : 0,
            archiveOrigin: 0,
          })
          expect(row.admissionRetrySuccesses).toEqual({
            reapi: scenario === 'retry-success' && index === 0 ? 1 : 0,
            archiveOrigin: 0,
          })
        }
      } finally {
        archive.stop(true)
        grpc.close()
      }
    })
  }

  it('preserves reader and writer admission when TLS succeeds without h2 ALPN', async () => {
    // Public test-only fixture, vendored verbatim from Bun 1.4.2 (valid through February 2036).
    // Regenerate these literals from the pinned upstream cert.pem and cert.key, not by hand:
    // https://github.com/oven-sh/bun/tree/744846f844374847c902b5e7fd59b4342a51ef99/test/js/bun/http/fixtures
    const cert = `-----BEGIN CERTIFICATE-----
MIIEDDCCAvSgAwIBAgIUbddWE2woW5e96uC4S2fd2M0AsFAwDQYJKoZIhvcNAQEL
BQAwfjELMAkGA1UEBhMCU0UxDjAMBgNVBAgMBVN0YXRlMREwDwYDVQQHDAhMb2Nh
dGlvbjEaMBgGA1UECgwRT3JnYW5pemF0aW9uIE5hbWUxHDAaBgNVBAsME09yZ2Fu
aXphdGlvbmFsIFVuaXQxEjAQBgNVBAMMCWxvY2FsaG9zdDAeFw0yNjAyMTMyMzEx
MjlaFw0zNjAyMTEyMzExMjlaMH4xCzAJBgNVBAYTAlNFMQ4wDAYDVQQIDAVTdGF0
ZTERMA8GA1UEBwwITG9jYXRpb24xGjAYBgNVBAoMEU9yZ2FuaXphdGlvbiBOYW1l
MRwwGgYDVQQLDBNPcmdhbml6YXRpb25hbCBVbml0MRIwEAYDVQQDDAlsb2NhbGhv
c3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCt7iqkEIco372hv19q
0zjaYbm6gzxEnR45UjpQYqgztq4QHicD80mqIkCBCYknFxhwxhNn+Y3g5RWQdRep
lpQbkneqRVp+qixMvu2FmOA4zRRoqObP7FyF1Yusvmroe0Y9SP2xTTmA9Zo73pay
wPUIuZ9eKGwIiFTtj1yQ1FdghLhzZgxcf3LHEHRkGnxgxxNITFxh4nd6fGIjNqM5
fQAY8z35lMXdeWjrhtaqgFYB+Z20YY0X7LJx39vYao0wqW8sZjX88TqHI1zXWLpU
k6UK9RqaNza5xc80wV+9/zjhr3dc1FRjBxI1DS/ufo33dUfvilxv9/LtWwUnKfKL
ns9LAgMBAAGjgYEwfzAdBgNVHQ4EFgQUQCpSY7ODhdyD6pdZHvfHoWRXWsIwHwYD
VR0jBBgwFoAUQCpSY7ODhdyD6pdZHvfHoWRXWsIwDwYDVR0TAQH/BAUwAwEB/zAs
BgNVHREEJTAjgglsb2NhbGhvc3SHBH8AAAGHEAAAAAAAAAAAAAAAAAAAAAEwDQYJ
KoZIhvcNAQELBQADggEBAGKTIzGQsOqfD0+x15F2cu7FKjIo1ua0OiILAhPqGX65
kGcetjC/dJip2bGnw1NjG9WxEJNZ4YcsGrwh9egfnXXmfHNL0wzx/LTo2oysbXsN
nEj+cmzw3Lwjn/ywJc+AC221/xrmDfm3m/hMzLqncnj23ZAHqkXTSp5UtSMs+UDQ
my0AJOvsDGPVKHQsAX3JDjKHaoVJn4YqpHcIGmpjrNcQSvwUocDHPcC0ywco6SgF
Ylzy2bwWWdPd9Cz9JkAMb95nWc7Rwf/nxAqCjJFzKEisvrx7VZ+QSVI0nqJzt8V1
pbtWYH5gMFVstU3ghWdSLbAk4XufGYrIWAlA5mqjQ4o=
-----END CERTIFICATE-----
`
    const key = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCt7iqkEIco372h
v19q0zjaYbm6gzxEnR45UjpQYqgztq4QHicD80mqIkCBCYknFxhwxhNn+Y3g5RWQ
dReplpQbkneqRVp+qixMvu2FmOA4zRRoqObP7FyF1Yusvmroe0Y9SP2xTTmA9Zo7
3paywPUIuZ9eKGwIiFTtj1yQ1FdghLhzZgxcf3LHEHRkGnxgxxNITFxh4nd6fGIj
NqM5fQAY8z35lMXdeWjrhtaqgFYB+Z20YY0X7LJx39vYao0wqW8sZjX88TqHI1zX
WLpUk6UK9RqaNza5xc80wV+9/zjhr3dc1FRjBxI1DS/ufo33dUfvilxv9/LtWwUn
KfKLns9LAgMBAAECggEAAacPHM2G7GBIm/9rCr6tvihNgD8M685zOOZAqGYn9CqY
cYHC4gtF/L2U6CBj2pNAoCwo3LXUkD+6r7MYKXAgqQg3HTCM4rwFbhD1rU8FVHfh
OL0QwwZ2ut95DVdjoxTAlEN9ZcdSFc//llMJ1cF8lxoVvKFc4cv3uCI2mcaJk858
iABfJLl3yfdv1xtpAuOfXf66sXbAmn5NQfN0qTEg2iOdgb4BUee5Wb35MakDQb6+
/s7/bWB+ublZzYt12ChIh1jkBBHaGyQ8mFnPj99ZAJdFjAzi6ydoJ0a2rCVY7Ugs
bkhnzDUtAaHKxo9JXaqIwbUaVFkX8dDhbg82dJrWUQKBgQDb7hNR0bJFW845N19M
74p2PM+0dIiVzwxAg4E2dXDVe39awO/tw8Vu1o1+NPFhWAzGcidP7pAHmPEgRTVO
7LA2P3CDXpkAEx5E0QW6QWZGqHfSa3+P1AvetvAV+OxtlDphcNeLApY16TUVOKZg
SZlxW2e0dZylbHewgLBTIV9wUQKBgQDKdML+JD18WfenPeowsw8HzKdaw01iGiV1
fvTjEXu6YxPPynWFMuj5gjBQodXM2vv0EsQBAPKYfe0nzRFL2kNuYs7TLoaNxqkp
DNfJ2Ww5OSg7Mp76XgppeKKlsXLyUMYHHrDh6MRi5jvWtiHRpaNmV3cHMRs22c+B
cqKP5Zma2wKBgCPNnS2Lsrbh3C+qWQRgVq0q9zFMa1PgEgGKpwVjlwvaAACZOjX9
0e1aVkx+d/E98U55FPdJQf9Koa58NdJ0a7dZGor4YnYFpr7TPFh2/xxvnpoN0AVt
IsWOCIW7MVohcGOeiChkMmnyXibnQwaX1LgEhlx1bRvtDYsZWBsgarYRAoGAARvo
oYnDSHYZtDHToZapg2pslEOzndD02ZLrdn73BYtbZWz/fc5MlmlPKHHqgOfGL40W
w8akjY9LCEfIS3kTm3wxE9kSZZ5r+MyYNgPZ4upcPQ7G7iortm4xveSd85PbsdhK
McKbqMsIEuIGh2Z34ayi+0galQ9WYqglGdKxJ7cCgYEAuSPBHa+en0xaraZNRvMk
OfV9Su/wrpR3TXSeo0E1mZHLwq1JwulpfO1SjxTH5uOJtG0tusl122wfm0KjrXUO
vG5/It+X4u1Nv9oWj+z1+EV4fQrQ/Coqcc1r+5w1yzfURkKlHh74jbK5Yy/KfXrE
eqbbJD40tKhY8ho15D3iCSo=
-----END PRIVATE KEY-----
`
    let handshakes = 0
    const tls = createTlsServer({ cert, key }, (socket) => {
      handshakes++
      socket.on('error', () => {})
      socket.end()
    })
    tls.on('tlsClientError', () => {})
    tls.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => tls.once('listening', resolve))
    const bound = tls.address()
    if (bound === null || typeof bound === 'string') throw new Error('expected TLS listener')
    try {
      const cases = ['reader', 'optional', 'strict'].map((posture) => {
        const root = fixture()
        writeFileSync(
          join(root, '.buckconfig'),
          `[buck2]\nremote_cache_enabled = true\nallow_cache_uploads = false\n[buck2_re_client]\naction_cache_address = grpc://127.0.0.1:${bound.port}\ninstance_name = fixture\ntls = true\n`,
        )
        return {
          cwd: root,
          cacheDirectory: join(root, 'probe-cache'),
          args: ['build', '//:app'],
          env:
            posture === 'reader'
              ? {}
              : {
                  BUCK2_CACHE_WRITE_BASIC_AUTH: 'fixture-secret',
                  ...(posture === 'optional' ? { BUCK2_CACHE_WRITE_OPTIONAL: '1' } : {}),
                },
        }
      })
      const certificate = join(cases[0]?.cwd ?? '', 'fixture-ca.pem')
      writeFileSync(certificate, cert)
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          '-e',
          `import {directBuckArguments} from ${JSON.stringify(import.meta.dir + '/buck2-entrypoint.ts')};
const outcomes = [];
for (const options of ${JSON.stringify(cases)}) {
  try { outcomes.push({args: await directBuckArguments(options)}) }
  catch(error) { outcomes.push({error: error.message}) }
}
console.log(JSON.stringify(outcomes));`,
        ],
        env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exitCode).toBe(0)
      expect(handshakes).toBe(6)
      const outcomes = JSON.parse(stdout) as {
        readonly args?: string[]
        readonly error?: string
      }[]
      for (const outcome of outcomes.slice(0, 2)) {
        expect(effective(outcome.args ?? [])['buck2.remote_cache_enabled']).toBe('false')
        expect(effective(outcome.args ?? [])['buck2.allow_cache_uploads']).toBe('false')
      }
      expect(outcomes[2]?.error).toContain('refusing to publish without remote cache')
      expect(stderr.match(/warning: Buck2 REAPI probe failed:/gu)).toHaveLength(6)
      expect(stderr).not.toContain('ERR_HTTP2_SOCKET_UNBOUND')
      expect(stderr).not.toContain('fixture-secret')
    } finally {
      tls.close()
    }
  })

  it('falls back an unavailable REAPI endpoint without overwriting concurrent checkout configuration or run arguments', async () => {
    const root = fixture()
    const local = '[ui]\ncolor = false\n'
    writeFileSync(join(root, '.buckconfig.local'), local)
    const result = await directBuckArguments({
      ...options(root),
      args: ['run', '//:app', '--', '-c', 'buck2.remote_cache_enabled=true'],
    })
    expect(effective(result)['buck2.remote_cache_enabled']).toBe('false')
    expect(effective(result)['archive_origin.url_prefix']).toBeUndefined()
    expect(result.slice(result.indexOf('--'))).toEqual([
      '--',
      '-c',
      'buck2.remote_cache_enabled=true',
    ])
    expect(readFileSync(join(root, '.buckconfig.local'), 'utf8')).toBe(local)
  })

  it('admits RE-only roots with the consuming default, without requiring archive metadata', async () => {
    const root = fixture()
    const config = readFileSync(join(root, '.buckconfig'), 'utf8')
    writeFileSync(
      join(root, '.buckconfig'),
      config
        .slice(0, config.indexOf('[archive_origin]'))
        .replace('remote_cache_enabled = true\n', ''),
    )
    const reader = await directBuckArguments({ ...options(root), args: ['build', '//:app'] })
    expect(effective(reader)['buck2.remote_cache_enabled']).toBe('false')
    await expect(
      directBuckArguments({
        ...options(root),
        env: { BUCK2_CACHE_WRITE_BASIC_AUTH: 'publisher-credential' },
        args: ['build', '//:app'],
      }),
    ).rejects.toThrow('refusing to publish')
  })

  for (const githubActions of ['true', 'false', undefined]) {
    it(`annotates writer refusal only in GitHub Actions (${githubActions ?? 'unset'})`, async () => {
      const root = fixture()
      const childPath = join(root, 'writer-refusal.ts')
      writeFileSync(
        childPath,
        `
import { directBuckArguments } from ${JSON.stringify(join(import.meta.dir, 'buck2-entrypoint.ts'))}
const options = {
  cwd: ${JSON.stringify(root)},
  cacheDirectory: ${JSON.stringify(join(root, 'probe-cache'))},
  args: ['build', '//:app'],
  env: ${JSON.stringify({
    GITHUB_ACTIONS: githubActions,
    BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: 'fixture-secret',
    BUCK2_PRIVATE_CACHE_ADDRESS: 'grpc://127.0.0.1:1',
  })},
}
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    await directBuckArguments(options)
    throw new Error('writer unexpectedly admitted')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
  }
}
`,
      )
      const child = Bun.spawn([process.execPath, childPath], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stderr = await new Response(child.stderr).text()
      expect(await child.exited).toBe(0)
      const failures = Array.from(
        stderr.matchAll(
          /warning: Buck2 REAPI probe failed: (class=\S+ phase=\S+ elapsed_ms=\d+ deadline_ms=2500)/gu,
        ),
        (match) => match[1],
      )
      expect(failures).toHaveLength(2)
      const annotations = stderr
        .split('\n')
        .filter((line) => line.startsWith('::error title=Buck2 cache writer refused::'))
      expect(annotations).toEqual(
        githubActions === 'true'
          ? Array(2).fill(
              `::error title=Buck2 cache writer refused::REAPI unreachable (${failures.at(-1)}); refusing to publish without remote cache`,
            )
          : [],
      )
      expect(
        stderr.match(
          /Buck cache writer: REAPI unreachable; refusing to publish without remote cache/gu,
        ),
      ).toHaveLength(2)
      expect(stderr).not.toContain('fixture-secret')
    })
  }

  it('falls back to local execution without uploads only for an optional writer', async () => {
    const root = fixture()
    const writer = {
      ...options(root),
      env: { BUCK2_CACHE_WRITE_BASIC_AUTH: 'publisher-credential' },
      args: ['build', '//:app'],
    }
    await expect(directBuckArguments(writer)).rejects.toThrow('refusing to publish')
    const result = await directBuckArguments({
      ...writer,
      env: { ...writer.env, BUCK2_CACHE_WRITE_OPTIONAL: '1' },
    })
    expect(effective(result)['buck2.remote_cache_enabled']).toBe('false')
    expect(effective(result)['buck2.allow_cache_uploads']).toBe('false')
  })

  it('uses effective CLI cache disabling rather than the tracked posture', async () => {
    const root = fixture()
    const result = await directBuckArguments({
      ...options(root),
      args: ['build', '//:app', '-c', 'buck2.remote_cache_enabled=false'],
    })
    const values = effective(result)
    expect(values['buck2.remote_cache_enabled']).toBe('false')
    expect(values['archive_origin.url_prefix']).toBeUndefined()
  })

  it('admits cache-less source builds without validating unused sandbox cache placeholders', async () => {
    for (const selection of [
      { args: ['build', '--local-only', '--no-remote-cache', '//:app'], env: {} },
      { args: ['build', '//:app'], env: { BUCK2_NO_REMOTE_CACHE: '1' } },
      { args: ['build', '-c', 'buck2.remote_cache_enabled=false', '//:app'], env: {} },
    ]) {
      const root = fixture('$BUCK2_CACHE_ADDRESS', '$BUCK2_ARCHIVE_ORIGIN_URL_PREFIX')
      const result = await directBuckArguments({ ...options(root), ...selection })
      expect(effective(result)['buck2.remote_cache_enabled']).toBe('false')
      expect(effective(result)['buck2.allow_cache_uploads']).toBe('false')
      expect(effective(result)['archive_origin.url_prefix']).toBeUndefined()
    }
    const root = fixture('$BUCK2_CACHE_ADDRESS', '$BUCK2_ARCHIVE_ORIGIN_URL_PREFIX')
    writeFileSync(join(root, '.buckconfig.local'), '[buck2]\nremote_cache_enabled = false\n')
    const result = await directBuckArguments({ ...options(root), args: ['build', '//:app'] })
    expect(effective(result)['archive_origin.url_prefix']).toBeUndefined()
    expect(effective(result)['buck2.remote_cache_enabled']).toBe('false')
  })

  it('ignores seeder-only archive metadata even when remote cache remains enabled', async () => {
    const root = fixture('grpc://127.0.0.1:1', '$BUCK2_ARCHIVE_ORIGIN_URL_PREFIX')
    const result = await directBuckArguments({
      ...options(root),
      args: ['run', '//:app', '--', '--no-remote-cache'],
    })
    expect(effective(result)['archive_origin.url_prefix']).toBeUndefined()
    expect(effective(result)['buck2.remote_cache_enabled']).toBe('false')
  })

  it('caches healthy capabilities across hot loops but does not reuse them for a different endpoint or writer credential', async () => {
    let requests = 0
    const grpc = createServer()
    grpc.on('stream', (stream: ServerHttp2Stream) => {
      requests++
      stream.on('data', () => {})
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' })
        stream.end(Buffer.from([0, 0, 0, 0, 0]))
      })
    })
    grpc.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => grpc.once('listening', resolve))
    const bound = grpc.address()
    if (bound === null || typeof bound === 'string') throw new Error('expected TCP listener')
    try {
      const root = fixture(`grpc://127.0.0.1:${bound.port}`)
      for (let index = 0; index < 3; index++) {
        const result = await directBuckArguments({ ...options(root), args: ['build', '//:app'] })
        expect(effective(result)['buck2.remote_cache_enabled']).not.toBe('false')
        expect(effective(result)['archive_origin.url_prefix']).toBeUndefined()
      }
      expect(requests).toBe(1)
      const ignoredClientOverride = await directBuckArguments({
        ...options(root),
        args: ['build', '//:app', '-c', 'buck2_re_client.action_cache_address=grpc://127.0.0.1:1'],
      })
      expect(effective(ignoredClientOverride)['buck2.remote_cache_enabled']).not.toBe('false')
      const config = readFileSync(join(root, '.buckconfig'), 'utf8')
      writeFileSync(
        join(root, '.buckconfig'),
        config.replace(`grpc://127.0.0.1:${bound.port}`, 'grpc://127.0.0.1:1'),
      )
      const changed = await directBuckArguments({ ...options(root), args: ['build', '//:app'] })
      expect(effective(changed)['buck2.remote_cache_enabled']).toBe('false')
      writeFileSync(join(root, '.buckconfig'), config)
      await directBuckArguments({
        ...options(root),
        env: {
          BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: 'writer-credential',
          BUCK2_PRIVATE_CACHE_ADDRESS: `grpc://127.0.0.1:${bound.port}`,
        },
        args: ['build', '//:app'],
      })
      expect(requests).toBe(2)
      await expect(
        directBuckArguments({
          ...options(root),
          env: {
            BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH: 'writer-credential',
            BUCK2_PRIVATE_CACHE_ADDRESS: 'grpc://127.0.0.1:1',
          },
          args: ['build', '//:app'],
        }),
      ).rejects.toThrow('refusing to publish')
    } finally {
      grpc.close()
    }
  })
})

describe('direct pinned Buck watcher admission', () => {
  it('admits a healthy service in a watcher-only root before the cache opt-in return', async () => {
    const { root, env, calls } = watcherFixture()
    const args = ['run', '//:app', '--', '--version', '--help', '-c', 'buck2.file_watcher=notify']
    const result = await directBuckArguments({ ...options(root), env, args })
    expect(result).toEqual(args)
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
    expect(readFileSync(calls, 'utf8')).toBe(
      `--no-spawn --no-local --sockname=${env.WATCHMAN_SOCK} --output-encoding=json watch-project ${root}\n`,
    )
  })

  it('allows the un-niced default service to spawn on every platform, including Darwin', async () => {
    const { root, env, calls } = watcherFixture()
    await directBuckArguments({
      ...options(root),
      env: { ...env, WATCHMAN_SOCK: undefined },
      args: ['build', '//:app'],
    })
    expect(readFileSync(calls, 'utf8')).toBe(
      `${getPriority() > 0 ? '--no-spawn ' : ''}--no-local --output-encoding=json watch-project ${root}\n`,
    )
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
  })

  it('fails closed when the executable exists but the service cannot be reached', async () => {
    const { root, env, state } = watcherFixture()
    writeFileSync(state, 'unreachable')
    await expect(
      directBuckArguments({ ...options(root), env, args: ['build', '//:app'] }),
    ).rejects.toThrow('Watchman watch-project probe failed (service)')
    expect(watcherLocal(root)).not.toContain('file_watcher = notify')
  })

  it('maps a Watchman nice refusal to an actionable fail-closed priority error', async () => {
    const { root, env, state } = watcherFixture()
    writeFileSync(state, 'nice-refusal')
    await expect(
      directBuckArguments({ ...options(root), env, args: ['build', '//:app'] }),
    ).rejects.toThrow(
      'Watchman refuses to start at nice 19; this client may only connect to an already-running service.',
    )
    await expect(
      directBuckArguments({ ...options(root), env, args: ['build', '//:app'] }),
    ).rejects.toThrow('watchman get-sockname` outside the gate')
    expect(watcherLocal(root)).not.toContain('file_watcher = notify')
  })

  for (const mode of ['healthy', 'missing'] as const) {
    describe(`prepared default-service client with ${mode} service`, () => {
      let setup: { root: string; calls: string }
      let prepared: PreparedEntrypoint
      beforeEach(async () => {
        const fixture = watcherFixture()
        setup = fixture
        const { root, env, state } = fixture
        if (mode === 'missing') rmSync(state)
        else writeFileSync(state, 'healthy')
        prepared = await prepareEntrypointProcess({
          root,
          args: [
            '-e',
            `import { setPriority } from 'node:os';
           import { directBuckArguments } from ${JSON.stringify(join(import.meta.dir, 'buck2-entrypoint.ts'))};
           setPriority(19);
           try {
             await directBuckArguments({ cwd: ${JSON.stringify(root)}, env: process.env, args: ['build', '//:app'], probeDeadlineSignal: (endpoint) => endpoint === 'watchman' ? new AbortController().signal : undefined });
           } catch (error) { console.error(error.message); process.exit(1); }`,
          ],
          env: { ...env, WATCHMAN_SOCK: undefined },
        })
      })
      it(`a nice 19 default-service client connects only to a ${mode} service`, async () => {
        const { root, calls } = setup
        const { child, stdout } = prepared
        child.stdin.write('\n')
        child.stdin.end()
        const [exit, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
          stdout,
        ])
        expect(exit).toBe(mode === 'healthy' ? 0 : 1)
        expect(readFileSync(calls, 'utf8')).toBe(
          mode === 'missing'
            ? `--no-spawn --no-local --output-encoding=json watch-project ${root}\n--no-spawn --output-encoding=json get-sockname\n`
            : `--no-spawn --no-local --output-encoding=json watch-project ${root}\n`,
        )
        if (mode === 'missing') {
          expect(stderr).toContain('no default Watchman service is running')
          expect(stderr).toContain('watchman get-sockname` outside the gate')
          expect(watcherLocal(root)).not.toContain('file_watcher = notify')
        } else expect(watcherLocal(root)).toContain('file_watcher = watchman')
      })
    })
  }

  for (const [mode, expected] of [
    ['refused', 'probe failed (service)'],
    ['eacces', 'probe failed (executable)'],
  ] as const) {
    describe(`prepared nice 19 client facing ${mode}`, () => {
      let root: string
      let prepared: PreparedEntrypoint
      beforeEach(async () => {
        const fixture = watcherFixture()
        root = fixture.root
        const { env, state } = fixture
        if (mode === 'refused') writeFileSync(state, 'refused')
        else {
          rmSync(state)
          chmodSync(join(root, 'watchman'), 0o644)
        }
        prepared = await prepareEntrypointProcess({
          root,
          args: [
            '-e',
            `import { setPriority } from 'node:os';
         import { directBuckArguments } from ${JSON.stringify(join(import.meta.dir, 'buck2-entrypoint.ts'))};
         setPriority(19);
         try {
           await directBuckArguments({ cwd: ${JSON.stringify(root)}, env: process.env, args: ['build', '//:app'], probeDeadlineSignal: (endpoint) => endpoint === 'watchman' ? new AbortController().signal : undefined });
         } catch (error) { console.error(error.message); process.exit(1); }`,
          ],
          env: {
            ...env,
            WATCHMAN_SOCK: undefined,
            PATH: mode === 'eacces' ? root : env['PATH'],
          },
        })
      })
      it(`a nice 19 client facing ${mode} keeps the genuine failure class`, async () => {
        const { child, stdout } = prepared
        child.stdin.write('\n')
        child.stdin.end()
        const [exit, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
          stdout,
        ])
        expect(exit).toBe(1)
        expect(stderr).toContain(expected)
        expect(stderr).not.toContain('(priority)')
        expect(stderr).not.toContain('watchman get-sockname` outside the gate')
        expect(watcherLocal(root)).not.toContain('file_watcher = notify')
      })
    })
  }

  it.each(['wrong-root', 'relative-root'])(
    'fails closed on %s Watchman selection',
    async (mode) => {
      const { root, env, state } = watcherFixture()
      writeFileSync(state, mode)
      await expect(
        directBuckArguments({ ...options(root), env, args: ['build', '//:app'] }),
      ).rejects.toThrow(`watchman watch '${root}'`)
      expect(watcherLocal(root)).not.toContain('file_watcher = notify')
    },
  )

  it('retries a transient Watchman timeout once and admits the healthy response', async () => {
    const { root, env, state, calls } = watcherFixture()
    writeFileSync(state, 'retry-timeout')
    writeFileSync(calls, '')
    const probeDeadlines: AbortController[] = []
    let observing = true
    const observer = watch(calls, () => {
      if (observing === false) return
      const deadline = probeDeadlines[0]
      if (deadline === undefined) throw new Error('expected held Watchman attempt deadline')
      if (deadline.signal.aborted === false && readFileSync(calls, 'utf8') !== '') deadline.abort()
    })
    try {
      await directBuckArguments({
        ...options(root),
        env,
        args: ['build', '//:app'],
        deadlineMs: 1000,
        probeDeadlineSignal: (endpoint) => {
          if (endpoint !== 'watchman') return undefined
          const deadline = new AbortController()
          probeDeadlines.push(deadline)
          return deadline.signal
        },
      })
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
      expect(watcherLocal(root)).toContain('file_watcher = watchman')
      expect(probeDeadlines.map((deadline) => deadline.signal.aborted)).toEqual([true, false])
    } finally {
      observing = false
      observer.close()
    }
  })

  it('does not cache failed admission after the service recovers', async () => {
    const { root, env, state, calls } = watcherFixture()
    writeFileSync(state, 'unreachable')
    const invocation = { ...options(root), env, args: ['build', '//:app'] }
    await expect(directBuckArguments(invocation)).rejects.toThrow('probe failed (service)')
    writeFileSync(state, 'healthy')
    await directBuckArguments(invocation)
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
  })

  it('invalidates a healthy root admission when Watchman ignore configuration changes', async () => {
    const { root, env, state, calls } = watcherFixture()
    const invocation = { ...options(root), env, args: ['build', '//:app'] }
    await directBuckArguments(invocation)
    writeFileSync(state, 'unreachable')
    writeFileSync(join(root, '.watchmanconfig'), '{"ignore_dirs":["ignored"]}\n')
    await expect(directBuckArguments(invocation)).rejects.toThrow('probe failed (service)')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('names every watcher admission variant with the physical worktree root hash', async () => {
    const { root, env } = watcherFixture()
    const cacheDirectory = join(root, 'root-keyed-probe-cache')
    for (const runtime of ['first-runtime', 'second-runtime']) {
      await directBuckArguments({
        ...options(root),
        env: { ...env, XDG_RUNTIME_DIR: runtime },
        cacheDirectory,
        args: ['targets', '//:app'],
      })
    }
    const prefix = `${createHash('sha256').update(realpathSync(root)).digest('hex')}-`
    const entries = readdirSync(cacheDirectory)
    expect(entries).toHaveLength(2)
    expect(entries.every((entry) => entry.startsWith(prefix) && entry.endsWith('.json'))).toBe(true)
  })

  it('does not share root admission between worktrees using the same service identity', async () => {
    const { root, env, calls } = watcherFixture()
    const otherRoot = fixture()
    writeFileSync(join(otherRoot, '.buckconfig'), '[buck2]\nfile_watcher = watchman\n')
    const cacheDirectory = join(root, 'shared-probe-cache')
    await directBuckArguments({ ...options(root), env, cacheDirectory, args: ['build', '//:app'] })
    await expect(
      directBuckArguments({
        ...options(otherRoot),
        env,
        cacheDirectory,
        args: ['build', '//:app'],
      }),
    ).rejects.toThrow('probe failed (service)')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('admits an explicit local Watchman provider only after checking the service', async () => {
    const { root, env, state } = watcherFixture()
    writeFileSync(join(root, '.buckconfig.local'), '[buck2]\nfile_watcher = watchman\n')
    writeFileSync(state, 'unreachable')
    await expect(
      directBuckArguments({ ...options(root), env, args: ['build', '//:app'] }),
    ).rejects.toThrow('probe failed (service)')
    expect(watcherLocal(root)).toBe('[buck2]\nfile_watcher = watchman\n')
  })

  it('preserves the existing explicit local notify opt-in without automatic selection', async () => {
    const { root, env, state, calls } = watcherFixture()
    writeFileSync(state, 'unreachable')
    const local = '[buck2]\nfile_watcher = notify\n'
    writeFileSync(join(root, '.buckconfig.local'), local)
    await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
    expect(watcherLocal(root)).toBe(local)
    expect(existsSync(calls)).toBe(false)
  })

  it('replaces legacy managed notify admission only with healthy Watchman', async () => {
    const { root, env } = watcherFixture()
    writeFileSync(
      join(root, '.buckconfig.local'),
      '# BEGIN effect-utils file watcher admission\n[buck2]\nfile_watcher = notify\n# END effect-utils file watcher admission\n',
    )
    await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
    expect(watcherLocal(root)).not.toContain('file_watcher = notify')
  })

  it('admits expand-external-cell daemon startup without applying the cache-command policy', async () => {
    const { root, env } = watcherFixture()
    writeFileSync(
      join(root, '.buckconfig'),
      '[buck2]\nfile_watcher = watchman\nremote_cache_enabled = true\n[buck2_re_client]\naction_cache_address = grpc://127.0.0.1:1\n',
    )
    const args = ['expand-external-cell', 'prelude']
    const result = await directBuckArguments({ ...options(root), env, args })
    expect(result).toEqual(args)
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
    expect(watcherLocal(root)).not.toContain('standalone cache posture')
  })

  it('does not query Watchman or mutate local configuration for help, version, or empty invocation', async () => {
    const { root, env, calls, state } = watcherFixture()
    writeFileSync(state, 'unreachable')
    const local = '[ui]\ncolor = false\n'
    writeFileSync(join(root, '.buckconfig.local'), local)
    for (const args of [
      [],
      ['--help'],
      ['-h'],
      ['--version'],
      ['build', '--help'],
      ['kill'],
      ['status', '--snapshot'],
      ['log', 'show', '--recent', '0'],
      ['--isolation-dir', 'owned', 'kill'],
    ]) {
      const result = await directBuckArguments({ ...options(root), env, args })
      expect(result).toEqual(args)
      expect(watcherLocal(root)).toBe(local)
    }
    expect(existsSync(calls)).toBe(false)
  })

  it('does not bypass admission for a build target or isolation named like maintenance', async () => {
    const { root, env, state } = watcherFixture()
    writeFileSync(state, 'unreachable')
    for (const args of [
      ['build', 'status'],
      ['--isolation-dir', 'status', 'build', '//:app'],
    ])
      await expect(directBuckArguments({ ...options(root), env, args })).rejects.toThrow(
        'probe failed',
      )
  })

  it.each(['malformed', 'error', 'wrong-type', 'missing-version', 'missing-root'])(
    'rejects %s service version output',
    async (mode) => {
      const { root, env, state } = watcherFixture()
      writeFileSync(state, mode)
      await expect(
        directBuckArguments({ ...options(root), env, args: ['build', '//:app'] }),
      ).rejects.toThrow('Watchman watch-project probe failed (response)')
      expect(watcherLocal(root)).not.toContain('file_watcher = notify')
    },
  )

  it('expires a healthy probe so a stopped service fails rather than switching to notify', async () => {
    const { root, env, state, calls } = watcherFixture()
    const invocation = { ...options(root), env, args: ['build', '//:app'] }
    await directBuckArguments(invocation)
    writeFileSync(state, 'unreachable')
    await directBuckArguments(invocation)
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1)
    try {
      setSystemTime(new Date(Date.now() + 5001))
      await expect(directBuckArguments(invocation)).rejects.toThrow('probe failed (service)')
      expect(watcherLocal(root)).toContain('file_watcher = watchman')
      expect(watcherLocal(root)).not.toContain('file_watcher = notify')
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
    } finally {
      setSystemTime()
    }
  })

  for (const identity of [
    'PATH',
    'HOME',
    'XDG_RUNTIME_DIR',
    'WATCHMAN_SOCK',
    'WATCHMAN_STATE_DIR',
    'TMPDIR',
    'TMP',
    'USER',
    'LOGNAME',
    'WATCHMAN_CONFIG_FILE',
  ] as const) {
    describe(`prepared watcher identity ${identity}`, () => {
      let setup: {
        root: string
        env: Record<string, string>
        state: string
        calls: string
      }
      beforeEach(async () => {
        setup = watcherFixture()
        const { root, env, calls } = setup
        await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
        expect(watcherLocal(root)).toContain('file_watcher = watchman')
        expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1)
      })
      it(`does not reuse a healthy service probe after ${identity} changes`, async () => {
        const { root, env, state, calls } = setup
        if (identity !== 'WATCHMAN_SOCK') writeFileSync(state, 'unreachable')
        const changed = {
          ...env,
          [identity]: identity === 'PATH' ? `${env.PATH}:/nonexistent` : join(root, 'changed'),
        }
        if (identity === 'WATCHMAN_SOCK') writeFileSync(join(root, 'changed'), 'unreachable')
        await expect(
          directBuckArguments({ ...options(root), env: changed, args: ['build', '//:app'] }),
        ).rejects.toThrow('probe failed (service)')
        expect(watcherLocal(root)).not.toContain('file_watcher = notify')
        expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
      })
    })
  }

  it('removes stale admission while preserving a later unmanaged sandbox provider and cache overlay', async () => {
    const { root, env, calls } = watcherFixture()
    await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
    const cacheOverlay =
      '# effect-utils standalone cache posture: begin\n[buck2]\n  remote_cache_enabled = false\n# effect-utils standalone cache posture: end\n'
    writeFileSync(
      join(root, '.buckconfig.local'),
      `${watcherLocal(root)}\n${cacheOverlay}\n[buck2]\nfile_watcher = fs_hash_crawler\n[ui]\ncolor = false\n`,
    )
    await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
    const local = watcherLocal(root)
    expect(local).not.toContain('effect-utils file watcher admission')
    expect(local).toContain('file_watcher = fs_hash_crawler')
    expect(local).toContain(cacheOverlay.trimEnd())
    expect(local).toContain('[ui]\ncolor = false')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('preserves independent local cache configuration when watcher admission fails', async () => {
    const { root, env } = watcherFixture()
    const local =
      '# effect-utils standalone cache posture: begin\n[buck2]\nremote_cache_enabled = false\n# effect-utils standalone cache posture: end\n[ui]\ncolor = false\n'
    writeFileSync(join(root, '.buckconfig.local'), local)
    await directBuckArguments({ ...options(root), env, args: ['build', '//:app'] })
    expect(watcherLocal(root)).toContain(local.trimEnd())
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
    writeFileSync(join(root, 'other-socket'), 'unreachable')
    await expect(
      directBuckArguments({
        ...options(root),
        env: { ...env, WATCHMAN_SOCK: join(root, 'other-socket') },
        args: ['build', '//:app'],
      }),
    ).rejects.toThrow('probe failed (service)')
    expect(watcherLocal(root)).toContain(local.trimEnd())
    expect(watcherLocal(root)).not.toContain('file_watcher = notify')
    expect(watcherLocal(root)).toContain('file_watcher = watchman')
  })

  it('bounds and retries a hanging service query without admitting native builds', async () => {
    const { root, env, state, calls } = watcherFixture()
    writeFileSync(state, 'hanging')
    const started = performance.now()
    await expect(
      directBuckArguments({
        ...options(root),
        env,
        args: ['build', '//:app'],
        deadlineMs: 1000,
        // This case asserts the actual platform timer and its bounded retry.
        probeDeadlineSignal: undefined,
      }),
    ).rejects.toThrow('probe failed (timeout)')
    expect(performance.now() - started).toBeLessThan(5000)
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(watcherLocal(root)).not.toContain('file_watcher = notify')
  }, 5000)

  for (const mode of ['healthy', 'unreachable'] as const) {
    describe(`native Buck launch with ${mode} watcher admission`, () => {
      let setup: { root: string; state: string; env: Record<string, string> }
      let launchEnv: Record<string, string | undefined>
      let prepared: PreparedEntrypoint
      let launchCache: string
      beforeEach(async () => {
        setup = watcherFixture()
        writeFileSync(setup.state, mode)
        launchEnv = {
          ...process.env,
          ...setup.env,
          XDG_CACHE_HOME: join(setup.root, 'xdg-cache'),
        }
      })
      beforeEach(async () => {
        const { root } = setup
        const native = join(root, 'native-buck')
        writeFileSync(
          native,
          `#!${Bun.which('sh')}\nprintf 'native:%s\\n' "$*"\ncat .buckconfig.local\n`,
          { mode: 0o700 },
        )
        launchCache = join(root, 'launch-cache')
        prepared = await prepareEntrypointProcess({
          root,
          env: launchEnv,
          args: [
            join(import.meta.dir, 'buck2-entrypoint.ts'),
            native,
            '--launch-cache',
            launchCache,
            'build',
            '//:app',
          ],
        })
      })
      beforeEach(async () => {
        // Warm admission only after process/dependency preparation so its
        // existing short-lived cache cannot expire during cold startup.
        if (mode === 'healthy') {
          expect(
            await directBuckArguments({
              cwd: setup.root,
              env: launchEnv,
              args: ['build', '//:app'],
              probeDeadlineSignal: fixtureProbeDeadlineSignal,
            }),
          ).toEqual(['build', '//:app'])
        }
      })
      it('launches native Buck and caches argv only for healthy admission', async () => {
        const { child } = prepared
        child.stdin.write('\n')
        child.stdin.end()
        const [stdout, stderr, exitCode] = await Promise.all([
          prepared.stdout,
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(exitCode).toBe(mode === 'healthy' ? 0 : 1)
        expect(stdout.includes('native:build //:app')).toBe(mode === 'healthy')
        expect(existsSync(launchCache)).toBe(mode === 'healthy')
        if (mode === 'healthy') {
          expect(stderr).toBe('')
          expect(stdout).toContain('file_watcher = watchman')
          expect(readFileSync(launchCache, 'utf8').split('\n')[1]).toBe('build\0//:app\0')
        } else {
          expect(stderr).toContain('Watchman watch-project probe failed (service)')
          expect(stderr).toContain('Probe:')
          expect(stderr).toContain('Fix:')
          expect(stderr).toContain('Refusing to use notify')
        }
      })
    })
  }

  for (const mode of ['legacy', 'notify', 'concurrent', 'failed-stop'] as const) {
    describe(`selected worktree isolation for ${mode} daemon state`, () => {
      type LaunchResult = { exitCode: number; stdout: string; stderr: string }
      let prepare: () => Promise<PreparedEntrypoint>
      let firstChild: PreparedEntrypoint
      let secondChild: PreparedEntrypoint
      const launch = async ({ child, stdout: output }: PreparedEntrypoint) => {
        child.stdin.write('\n')
        child.stdin.end()
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          output,
          new Response(child.stderr).text(),
        ])
        return { exitCode, stdout, stderr }
      }
      let firstRun: LaunchResult
      let setup: {
        root: string
        env: Readonly<Record<string, string | undefined>>
        nativeCalls: string
        otherMarker: string
        otherWorktreeState: string
        other: string
        oldMarker: string
        selectedMarker: string
      }
      beforeEach(async () => {
        const { root, env } = watcherFixture()
        const launchEnv = {
          ...process.env,
          ...env,
          XDG_CACHE_HOME: join(root, 'xdg-cache'),
          BUCK_ISOLATION_DIR: mode === 'legacy' ? 'owned' : undefined,
        }
        const state = join(root, '.buck', 'buckd', root.slice(1))
        const selected = join(state, 'owned')
        const other = join(state, 'unrelated')
        const admission = join(root, '.buck', 'file-watcher-admission-v1', root.slice(1))
        const selectedMarker = join(admission, 'owned.json')
        const otherMarker = join(admission, 'unrelated.json')
        mkdirSync(admission, { recursive: true })
        const otherRoot = fixture()
        const otherWorktreeState = join(root, '.buck', 'buckd', otherRoot.slice(1), 'owned')
        mkdirSync(otherWorktreeState, { recursive: true })
        writeFileSync(join(otherWorktreeState, 'buckd.pid'), '888888')
        const oldMarker = JSON.stringify({
          schema: 'effect-utils/buck2-file-watcher-admission/v1',
          provider: 'notify',
        })
        for (const directory of [selected, other]) {
          mkdirSync(directory, { recursive: true })
          writeFileSync(join(directory, 'buckd.pid'), '999999')
        }
        writeFileSync(otherMarker, oldMarker)
        if (mode === 'notify') writeFileSync(selectedMarker, oldMarker)
        const nativeCalls = join(root, 'native-calls')
        const native = join(root, 'native-buck')
        writeFileSync(
          native,
          `#!${Bun.which('sh')}
printf '%s\\n' "$*" >> '${nativeCalls}'
if [ "$*" = "--isolation-dir owned kill" ]; then
  ${mode === 'failed-stop' ? 'exit 1' : `rm -rf '${selected}'\n  mkdir -p '${selected}'\n  exit 0`}
fi
printf '999998' > '${selected}/buckd.pid'
printf 'native build\\n'
`,
          { mode: 0o700 },
        )
        prepare = () =>
          prepareEntrypointProcess({
            root,
            env: launchEnv,
            args: [
              join(import.meta.dir, 'buck2-entrypoint.ts'),
              native,
              ...(mode === 'legacy'
                ? ['build', '//:app']
                : mode === 'notify'
                  ? ['--isolation-dir=owned', 'build', '//:app']
                  : ['--isolation-dir', 'owned', 'build', '//:app']),
            ],
          })
        setup = {
          root,
          env: launchEnv,
          nativeCalls,
          otherMarker,
          otherWorktreeState,
          other,
          oldMarker,
          selectedMarker,
        }
      })
      beforeEach(async () => {
        firstChild = await prepare()
      })
      beforeEach(async () => {
        secondChild = await prepare()
      })
      beforeEach(async () => {
        expect(
          await directBuckArguments({
            cwd: setup.root,
            env: setup.env,
            args: ['build', '//:app'],
            probeDeadlineSignal: fixtureProbeDeadlineSignal,
          }),
        ).toEqual(['build', '//:app'])
      })
      beforeEach(async () => {
        // A sequential replay gets its own guard rather than sharing the
        // second launch's deadline. Concurrent admission still races both CLIs.
        if (mode !== 'concurrent') firstRun = await launch(firstChild)
      })
      it('migrates only the selected worktree isolation', async () => {
        const { nativeCalls, otherMarker, otherWorktreeState, other, oldMarker, selectedMarker } =
          setup
        const runs =
          mode === 'concurrent'
            ? await Promise.all([launch(firstChild), launch(secondChild)])
            : [firstRun, await launch(secondChild)]
        const calls = readFileSync(nativeCalls, 'utf8').trim().split('\n')
        expect(readFileSync(otherMarker, 'utf8')).toBe(oldMarker)
        expect(readFileSync(join(otherWorktreeState, 'buckd.pid'), 'utf8')).toBe('888888')
        expect(readFileSync(join(other, 'buckd.pid'), 'utf8')).toBe('999999')
        if (mode === 'failed-stop') {
          expect(runs.every(({ exitCode }) => exitCode === 1)).toBe(true)
          expect(runs.every(({ stdout }) => stdout === '')).toBe(true)
          expect(calls).toEqual(['--isolation-dir owned kill', '--isolation-dir owned kill'])
          expect(existsSync(selectedMarker)).toBe(false)
        } else {
          expect(runs.every(({ exitCode }) => exitCode === 0)).toBe(true)
          expect(runs.every(({ stdout }) => stdout.includes('native build'))).toBe(true)
          expect(calls.filter((call) => call.endsWith(' kill'))).toEqual([
            '--isolation-dir owned kill',
          ])
          expect(JSON.parse(readFileSync(selectedMarker, 'utf8')).provider).toBe('watchman')
        }
      })
    })
  }
})

// These platform processes expose no awaitable state event to a non-parent.
// Fake time cannot advance systemd teardown or a native daemon's startup.
const waitForGateCondition = async (description: string, condition: () => boolean) => {
  const deadline = Date.now() + 30000
  while (condition() === false) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await Bun.sleep(25)
  }
}

describe('gate wrapper EXIT and signal traps', () => {
  for (const signal of ['EXIT', 'EXIT130', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    it(`preserves ${signal} status and cleans only the selected isolation`, async () => {
      const root = fixture()
      const packaged = process.env['BUCK2_BIN'] ?? Bun.which('buck2')
      if (packaged === null || packaged === undefined)
        throw new Error('pinned buck2 wrapper required')
      // PATH may contain a process-wrapping Bash shim; use the actual
      // interpreter selected by the packaged production wrapper.
      const bash = /^#!(\/\S+)\n/u.exec(readFileSync(packaged, 'utf8'))?.[1]
      if (bash === undefined) throw new Error('expected pinned Buck wrapper interpreter')
      writeFileSync(join(root, '.buckconfig'), '[cells]\nroot = .\n')
      const native = join(root, 'native')
      const launcher = join(root, 'launcher')
      const wrapper = join(root, 'buck2')
      const ready = join(root, 'ready')
      const started = join(root, 'started')
      const killed = join(root, 'killed')
      const received = join(root, 'received')
      const stopped = join(root, 'stopped')
      const signaled = signal !== 'EXIT' && signal !== 'EXIT130'
      writeFileSync(
        native,
        `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args.at(-1) === 'status') {
  if (existsSync(${JSON.stringify(started)})) console.log(JSON.stringify({project_root: ${JSON.stringify(realpathSync(root))}, isolation_dir: 'owned', active_commands: [], process_info: {pid: process.ppid}}))
} else if (args.at(-1) === 'kill') {
  if (${JSON.stringify(signaled)} && !existsSync(${JSON.stringify(stopped)})) appendFileSync(${JSON.stringify(killed)}, 'native still busy\\n')
  appendFileSync(${JSON.stringify(killed)}, args.join(' ') + '\\n')
} else if (${JSON.stringify(signaled)} === false) {
  writeFileSync(${JSON.stringify(started)}, 'started')
  process.exit(${signal === 'EXIT130' ? 130 : 23})
} else {
  writeFileSync(${JSON.stringify(started)}, 'started')
  const released = Promise.withResolvers()
  process.stdin.once('data', released.resolve)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, async () => {
    appendFileSync(${JSON.stringify(received)}, signal + '\\n')
    await released.promise
    writeFileSync(${JSON.stringify(stopped)}, 'stopped')
    process.exit(0)
  })
  await Bun.write(${JSON.stringify(ready)}, 'ready')
  process.stdin.resume()
  await Promise.withResolvers().promise
}
`,
        { mode: 0o700 },
      )
      writeFileSync(
        launcher,
        `#!${bash}\nexec '${process.execPath}' '${join(import.meta.dir, 'buck2-entrypoint.ts')}' "$@"\n`,
        { mode: 0o700 },
      )
      writeFileSync(
        wrapper,
        readFileSync(join(import.meta.dir, 'buck2-entrypoint.sh'), 'utf8')
          .replaceAll('@shell@', bash)
          .replaceAll('@native@', native)
          .replaceAll('@launcher@', launcher)
          .replaceAll('@sha256@', Bun.which('sha256sum') ?? 'false'),
        { mode: 0o700 },
      )
      // node:child_process exposes the parent's raw wait distinction rather
      // than flattening signal death to the shell-style numeric 128+signal.
      const env = process.platform === 'linux' ? Bun.which('env') : undefined
      if (env === null) throw new Error('GNU env required to reset inherited SIGINT')
      const args = [wrapper, '--isolation-dir', 'owned', 'build', '//:fixture']
      const command = env ?? wrapper
      const commandArgs =
        env === undefined ? args.slice(1) : ['--default-signal=INT', '--', ...args]
      const child = spawn(command, commandArgs, {
        cwd: root,
        detached: true,
        env: {
          ...process.env,
          BASH_ENV: undefined,
          GATE_SLOT_CLASS: 'heavy',
          BUCK2_GATE_WRAPPER_ACTIVE: undefined,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.stdout.resume()
      const completion = Promise.withResolvers<{ code: number | null; signal: string | null }>()
      child.once('error', completion.reject)
      child.once('close', (code, signal) => completion.resolve({ code, signal }))
      const exited = completion.promise
      if (child.pid === undefined) throw new Error('gate wrapper did not spawn')
      launchProcesses.add({ pid: child.pid, exited: exited.then(({ code }) => code ?? 0) })
      if (signaled === true) {
        await waitForGateCondition('fake native signal readiness', () => existsSync(ready))
        if (process.platform === 'linux') {
          expect(realpathSync(`/proc/${child.pid}/exe`)).toBe(realpathSync(bash))
          const wrapperEnv = readFileSync(`/proc/${child.pid}/environ`, 'utf8').split('\0')
          expect(wrapperEnv.some((entry) => entry.startsWith('BASH_ENV='))).toBe(false)
          const ignored = /^SigIgn:\s*([0-9a-f]+)$/imu.exec(
            readFileSync(`/proc/${child.pid}/status`, 'utf8'),
          )?.[1]
          if (ignored === undefined) throw new Error('missing wrapper SigIgn mask')
          expect(BigInt(`0x${ignored}`) & 2n).toBe(0n)
        }
        child.kill(signal)
        await waitForGateCondition('forwarded native signal', () => existsSync(received))
        // A second delivery while the native is draining must neither bypass
        // its wait nor trigger a second daemon cleanup.
        child.kill(signal)
        child.stdin.write('release\n')
      }
      const result = await exited
      expect(result, stderr).toEqual({
        code: signaled === true ? null : signal === 'EXIT130' ? 130 : 23,
        signal: signaled === true ? signal : null,
      })
      expect(child.signalCode).toBe(signaled === true ? signal : null)
      expect(readFileSync(killed, 'utf8')).toBe('--isolation-dir owned kill\n')
      if (signaled === true) {
        expect(readFileSync(received, 'utf8')).toBe(`${signal}\n`)
        expect(readFileSync(stopped, 'utf8')).toBe('stopped')
      }
      child.stdin.end()
    }, 60000)
  }
})

describe('Linux gate daemon lifecycle', () => {
  const manager =
    process.platform === 'linux' && Bun.which('systemctl') !== null
      ? Bun.spawnSync(['systemctl', '--user', 'show-environment'], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
      : { exitCode: 1, stderr: Buffer.from('ENOENT: systemctl --user unavailable') }
  const unavailable = process.platform !== 'linux' || manager.exitCode !== 0
  const reason =
    process.platform !== 'linux'
      ? `platform ${process.platform} has no Linux user manager`
      : manager.stderr.toString()
  if (unavailable === true) {
    it('asserts the reason for skipping the native user-manager proof', () => {
      expect(reason.length).toBeGreaterThan(0)
      if (process.platform === 'linux')
        expect(reason).toMatch(
          /not found|ENOENT|Failed to connect|No such file|No medium|not been booted/iu,
        )
      console.error(`SKIP buck2 gate scope: ${reason.trim()}`)
    })
  }
  it.skipIf(unavailable)(
    'keeps daemon/forkserver in the job scope, ends that scope, and retains an active concurrent client',
    async () => {
      const wrapper = process.env['BUCK2_BIN'] ?? Bun.which('buck2')
      if (wrapper === null || wrapper === undefined)
        throw new Error('pinned buck2 wrapper required')
      const native = join(dirname(dirname(realpathSync(wrapper))), 'libexec', 'buck2')
      expect(existsSync(native)).toBe(true)
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'buck2-gate-lifecycle-')))
      writeFileSync(join(root, '.buckroot'), '')
      writeFileSync(
        join(root, '.buckconfig'),
        '[cells]\nroot = .\n[buck2]\nfile_watcher = fs_hash_crawler\n',
      )
      const isolation = `gate-${randomUUID()}`
      const job = `gate-slot-buck2-test-${randomUUID()}.scope`
      const env = { ...process.env, GATE_SLOT_CLASS: 'heavy', BUCK2_GATE_WRAPPER_ACTIVE: undefined }
      const ungated = { ...env, GATE_SLOT_CLASS: '' }
      const command = (argv: string[]) =>
        Bun.spawnSync(argv, { cwd: root, env: ungated, stdout: 'pipe', stderr: 'pipe' })
      const status = () => {
        const result = command([native, '--isolation-dir', isolation, 'status'])
        if (result.exitCode !== 0) throw new Error(result.stderr.toString())
        return result.stdout.length === 0 ? undefined : JSON.parse(result.stdout.toString())
      }
      let client: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined
      let peer: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined
      try {
        expect(command([native, '--isolation-dir', isolation, 'server']).exitCode).toBe(0)
        const foreignIdlePid = status().process_info.pid
        client = Bun.spawn(
          [
            'systemd-run',
            '--user',
            '--scope',
            '--quiet',
            `--unit=${job}`,
            '--',
            wrapper,
            '--isolation-dir',
            isolation,
            'lsp',
          ],
          { cwd: root, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        )
        const clientStderr = new Response(client.stderr).text()
        const clientStdout = new Response(client.stdout).text()
        await waitForGateCondition(
          'gated LSP client',
          () => (status()?.active_commands.length ?? 0) > 0,
        )
        const daemon = status()
        expect(daemon.process_info.pid).not.toBe(foreignIdlePid)
        expect(existsSync(`/proc/${foreignIdlePid}`)).toBe(false)
        expect(readFileSync(`/proc/${daemon.process_info.pid}/cgroup`, 'utf8')).toContain(`/${job}`)
        expect(readFileSync(`/proc/${daemon.forkserver_pid}/cgroup`, 'utf8')).toContain(`/${job}`)
        console.log(command(['systemctl', '--user', 'status', job]).stdout.toString())
        client.stdin.end()
        expect(await client.exited, await clientStderr).toBe(0)
        await clientStdout
        expect(status()).toBeUndefined()
        await waitForGateCondition(
          'empty job scope removal',
          () =>
            command(['systemctl', '--user', 'show', job, '-p', 'LoadState', '--value'])
              .stdout.toString()
              .trim() === 'not-found',
        )
        console.log(`job scope ended and daemon stopped: ${job}`)

        const sameJob = `gate-slot-buck2-test-same-${randomUUID()}.scope`
        const sameStatus = join(root, 'same-scope-status.json')
        const sameScript = join(root, 'same-scope.sh')
        writeFileSync(
          sameScript,
          `#!${Bun.which('bash')}
set -e
'${native}' --isolation-dir '${isolation}' server --status > '${sameStatus}'
exec '${wrapper}' --isolation-dir '${isolation}' lsp
`,
          { mode: 0o700 },
        )
        client = Bun.spawn(
          ['systemd-run', '--user', '--scope', '--quiet', `--unit=${sameJob}`, '--', sameScript],
          { cwd: root, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        )
        const sameStderr = new Response(client.stderr).text()
        const sameStdout = new Response(client.stdout).text()
        await waitForGateCondition(
          'same-scope LSP attachment',
          () => (status()?.active_commands.length ?? 0) > 0,
        )
        expect(status().process_info.pid).toBe(
          JSON.parse(readFileSync(sameStatus, 'utf8')).process_info.pid,
        )
        expect(readFileSync(`/proc/${status().process_info.pid}/cgroup`, 'utf8')).toContain(
          `/${sameJob}`,
        )
        client.stdin.end()
        expect(await client.exited, await sameStderr).toBe(0)
        await sameStdout
        expect(status()).toBeUndefined()
        await waitForGateCondition(
          'same-scope job removal',
          () =>
            command(['systemctl', '--user', 'show', sameJob, '-p', 'LoadState', '--value'])
              .stdout.toString()
              .trim() === 'not-found',
        )
        console.log(
          'same-scope daemon reused without a restart; idle exit teardown removed its job scope',
        )

        // Quantify native cold startup separately from cached build work.
        const cold: number[] = []
        const warm: number[] = []
        for (let index = 0; index < 3; index++) {
          let pid: number | undefined
          for (const measurements of [cold, warm]) {
            const start = performance.now()
            const result = command([wrapper, '--isolation-dir', isolation, 'server'])
            expect(result.exitCode, result.stderr.toString()).toBe(0)
            measurements.push(performance.now() - start)
            const currentPid = status().process_info.pid
            if (pid !== undefined) expect(currentPid).toBe(pid)
            pid = currentPid
          }
          expect(command([native, '--isolation-dir', isolation, 'kill']).exitCode).toBe(0)
        }
        console.log(`cold/warm wrapper server milliseconds: ${JSON.stringify({ cold, warm })}`)

        peer = Bun.spawn([native, '--isolation-dir', isolation, 'lsp'], {
          cwd: root,
          env: ungated,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const peerStderr = new Response(peer.stderr).text()
        const peerStdout = new Response(peer.stdout).text()
        await waitForGateCondition(
          'concurrent peer attachment',
          () => (status()?.active_commands.length ?? 0) > 0,
        )
        const before = status().process_info.pid
        const foreignBusyCgroup = readFileSync(`/proc/${before}/cgroup`, 'utf8').trim()
        const busyJob = `gate-slot-buck2-test-busy-${randomUUID()}.scope`
        const gated = Bun.spawnSync(
          [
            'systemd-run',
            '--user',
            '--scope',
            '--quiet',
            `--unit=${busyJob}`,
            '--',
            wrapper,
            '--isolation-dir',
            isolation,
            'server',
          ],
          {
            cwd: root,
            env,
            stdout: 'pipe',
            stderr: 'pipe',
          },
        )
        expect(gated.exitCode, gated.stderr.toString()).toBe(0)
        const warnings = gated.stderr
          .toString()
          .split('\n')
          .filter((line) => line.startsWith('warning: Buck2 gate'))
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain(
          `reusing active daemon in foreign cgroup ${foreignBusyCgroup}`,
        )
        expect(status().process_info.pid).toBe(before)
        expect(peer.exitCode).toBeNull()
        peer.stdin.end()
        expect(await peer.exited, await peerStderr).toBe(0)
        await peerStdout
        console.log('active concurrent client retained; ungated daemon remains warm')
      } finally {
        client?.stdin.end()
        peer?.stdin.end()
        if (client !== undefined) await client.exited
        if (peer !== undefined) await peer.exited
        const stopped = command([native, '--isolation-dir', isolation, 'kill'])
        expect(stopped.exitCode, stopped.stderr.toString()).toBe(0)
        rmSync(root, { recursive: true, force: true })
        rmSync(join(homedir(), '.buck', 'buckd', root.slice(1)), { recursive: true, force: true })
      }
    },
    180000,
  )
})
