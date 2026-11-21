import { expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ReaderReapiUnavailableShadow } from './buck2-cache-posture.ts'
import {
  ciPostureDeclared,
  cacheLocalFallbackEligible,
  localCacheReplayArguments,
  runWithCacheLocalFallback,
  gateCgroupRelation,
  gateDaemonStopDecision,
  gateScopeIdentity,
  isOnlyReapiUnavailable,
  resolveManagedInvocation,
  runWithReaderCacheShadow,
  captureNativeStderr,
  shouldSuperviseReaderCommand,
  writeNativeStderrChunk,
} from './buck2-entrypoint.ts'
import {
  ownedEditorViewAuthorityCommandRunner,
  runManagedEditorPublicationCommand,
} from './editor-view-authority.ts'

it('adapts real owned native streams and census with native failure identity', () =>
  withPublicationRoot(async (cwd) => {
    const native = join(cwd, 'native')
    writeFileSync(native,
      '#!/bin/sh\nprintf "%s\\n" "$PWD" "$EXPLICIT_CONTEXT" "$@"\nprintf "\\342\\202\\254\\342" >&2\n',
      { mode: 0o755 })
    await withEditorPublicationOwner({
      root: cwd,
      run: async (owner) => {
        const chunks: string[] = []
        const command = {
          command: 'buck', cwd,
          args: ['--isolation-dir', editorPublicationIsolation, 'kill'],
          onStderr: (chunk: string): void => { chunks.push(chunk) },
        }
        const result = await runManagedEditorPublicationCommand({
          command, native, owner, env: { EXPLICIT_CONTEXT: 'adapter' },
        })
        expect(chunks.join('')).toBe('€�')
        expect(result.stderr).toBe('€�')
        expect(result.stdout).toBe(`${cwd}\nadapter\n--isolation-dir\n${editorPublicationIsolation}\nkill\n`)
        const uncaptured = await runManagedEditorPublicationCommand({
          command: { ...command, captureStderr: false }, native, owner, env: {},
        })
        expect(uncaptured.stderr).toBe('')
        const runner = ownedEditorViewAuthorityCommandRunner({
          buck2: 'buck', native, owner, env: { EXPLICIT_CONTEXT: 'census' },
          signal: new AbortController().signal,
        })
        const census = await runner({ command: 'buck', cwd, args: ['uquery', '//...'] })
        expect(Buffer.isBuffer(census.stdout)).toBe(true)
        expect(Buffer.isBuffer(census.stderr)).toBe(true)
        expect(Buffer.from(census.stdout).toString()).toBe(
          `${cwd}\ncensus\n--isolation-dir\n${editorPublicationIsolation}\nuquery\n//...\n`)
        const ordinary = await runner({ command: '/bin/sh', cwd, args: ['-c', 'printf ordinary'] })
        expect(Buffer.from(ordinary.stdout).toString()).toBe('ordinary')
        expect(requireEditorPublicationInvocationOwner({ ...command, env: {}, owner })).toBe(owner)
      },
    })
  }))

it('preserves managed native status, signal and pre-aborted command causes', () =>
  withPublicationRoot(async (cwd) => {
    const native = join(cwd, 'native')
    await withEditorPublicationOwner({
      root: cwd,
      run: async (owner) => {
        const command = {
          command: 'buck', cwd,
          args: ['--isolation-dir', editorPublicationIsolation, 'kill'],
        }
        writeFileSync(native, '#!/bin/sh\nexit 23\n', { mode: 0o755 })
        await expect(runManagedEditorPublicationCommand({ command, native, owner, env: {} }))
          .rejects.toMatchObject({ exitCode: 23, signal: undefined })
        writeFileSync(native, '#!/bin/sh\nkill -TERM $$\n', { mode: 0o755 })
        await expect(runManagedEditorPublicationCommand({ command, native, owner, env: {} }))
          .rejects.toMatchObject({ exitCode: undefined, signal: 'SIGTERM' })
        const controller = new AbortController()
        const cause = new Error('cancel before spawn')
        controller.abort(cause)
        await expect(runManagedEditorPublicationCommand({
          command: { ...command, signal: controller.signal }, native, owner, env: {},
        })).rejects.toBe(cause)
        expect(requireEditorPublicationInvocationOwner({ ...command, env: {}, owner })).toBe(owner)
      },
    })
  }))

const root = '/project/root'
const isolation = 'owned'
const idle = { project_root: root, isolation_dir: isolation, active_commands: [] }

it('selects CI posture only through the explicit workflow declaration', () => {
  expect(ciPostureDeclared({})).toBe(false)
  expect(ciPostureDeclared({ CI: '1' })).toBe(false)
  expect(ciPostureDeclared({ CI: 'true', GITHUB_ACTIONS: 'true' })).toBe(false)
  expect(ciPostureDeclared({ BUCK2_CI_POSTURE: 'true' })).toBe(false)
  expect(ciPostureDeclared({ BUCK2_CI_POSTURE: '1' })).toBe(true)
})

it('permits native kill only for an idle daemon in the selected project and isolation', () => {
  expect(gateDaemonStopDecision({ status: idle, root, isolation })).toBe('stop')
})

it('retains a daemon while any other client is active, even when the gate started it', () => {
  expect(
    gateDaemonStopDecision({
      status: { ...idle, active_commands: [{ command_name: 'build' }] },
      root,
      isolation,
    }),
  ).toBe('keep-active')
})

it('fails closed for absent, malformed, foreign-root or foreign-isolation status', () => {
  for (const status of [
    undefined,
    null,
    {},
    [],
    'no buckd running',
    { ...idle, active_commands: undefined },
    { ...idle, project_root: '/other/root' },
    { ...idle, isolation_dir: 'other' },
  ]) {
    expect(gateDaemonStopDecision({ status, root, isolation })).toBe('keep-unrecognized')
  }
})

it('compares nearest gate scope ownership for parent, nested and sibling memberships', () => {
  const scope = '/user.slice/user-1000.slice/user@1000.service/app.slice/gate-slot-heavy-123.scope'
  for (const suffix of ['', '/worker', '/worker/actions', '/sibling']) {
    expect(gateScopeIdentity(`0::${scope}${suffix}\n`)).toBe(scope)
  }
  expect(gateScopeIdentity(`0::${scope}/nested/gate-slot-heavy-456.scope/actions`)).toBe(
    `${scope}/nested/gate-slot-heavy-456.scope`,
  )
  expect(gateScopeIdentity(`0::${scope.replace('123', '999')}`)).not.toBe(scope)
})

it('does not invent gate ownership for non-unified, missing or ungated memberships', () => {
  for (const membership of ['', '1:memory:/gate-slot-heavy-123.scope', '0::relative', '0::/']) {
    expect(gateScopeIdentity(membership)).toBeUndefined()
  }
})

it('reuses parent, nested and sibling cgroups but migrates determinably foreign owners', () => {
  const scope = '/user.slice/app.slice/gate-slot-heavy-123.scope'
  for (const caller of [scope, `${scope}/worker`, `${scope}/sibling`]) {
    for (const daemon of [scope, `${scope}/actions`, `${scope}/other/actions`]) {
      expect(gateCgroupRelation({ caller: `0::${caller}`, daemon: `0::${daemon}` })).toBe('same')
    }
    expect(
      gateCgroupRelation({
        caller: `0::${caller}`,
        daemon: '0::/user.slice/app.slice/session.scope',
      }),
    ).toBe('foreign')
    expect(
      gateCgroupRelation({ caller: `0::${caller}`, daemon: `0::${scope.replace('123', '999')}` }),
    ).toBe('foreign')
    expect(gateCgroupRelation({ caller: `0::${caller}`, daemon: '1:memory:/unknown' })).toBe(
      'unknown',
    )
  }
  expect(
    gateCgroupRelation({ caller: '0::/user.slice/session.scope', daemon: `0::${scope}` }),
  ).toBe('unknown')
})

const reUnavailable = `Error: (Failed to query capabilities of remote: code: 'The service is currently unavailable', message: "tls handshake eof", source: tonic::transport::Error(Transport, ConnectError(...)))`
const reWarning =
  'WARN buck2_execute::re::client: Failed to connect to RE, retrying after sleeping 1 seconds: Remote Execution Error on REClientBuilder ...'

it('classifies only RE initialization/capabilities/connect unavailable diagnostics', () => {
  expect(isOnlyReapiUnavailable(reUnavailable)).toBe(true)
  expect(isOnlyReapiUnavailable(`${reWarning}\n${reUnavailable}\n${reUnavailable}`)).toBe(true)
  expect(
    isOnlyReapiUnavailable(`Error: Remote Execution Error on REClientBuilder: status: Unavailable`),
  ).toBe(true)
  expect(
    isOnlyReapiUnavailable(`Command failed: Failed to connect to RE: code: 'Unavailable'`),
  ).toBe(true)
  for (const output of [
    '',
    reWarning,
    'Error: service unavailable',
    'error[E0308]: mismatched types',
    'error TS2322: Type is not assignable',
    'TESTS FAILED: assertion failed',
    reUnavailable.replace('The service is currently unavailable', 'Unauthenticated'),
    reUnavailable.replace('The service is currently unavailable', 'PermissionDenied'),
    reUnavailable.replace('tls handshake eof', 'digest mismatch'),
    reUnavailable.replace('tls handshake eof', 'checksum mismatch'),
    reUnavailable.replace('tls handshake eof', 'certificate expired'),
    reUnavailable.replace('tls handshake eof', 'TLS unknown authority'),
    reUnavailable.replace('tls handshake eof', 'TLS bad cert'),
    reUnavailable.replace('tls handshake eof', 'server identity validation failed'),
    reUnavailable.replace('tls handshake eof', 'hostname mismatch'),
    `${reUnavailable}\nerror[E0308]: mismatched types`,
    `${reUnavailable}\nTESTS FAILED: assertion failed`,
    `${reUnavailable}\nError: permission denied`,
    `${reUnavailable}\nError: digest mismatch`,
    `${reUnavailable}\nError: unknown failure`,
  ])
    expect(isOnlyReapiUnavailable(output)).toBe(false)
})

// Public CI job 122291447993, with only GitHub's outer log prefix removed.
const incidentOutput = readFileSync(
  new URL('./fixtures/buck2-re-unavailable.txt', import.meta.url),
  'utf8',
)

it('classifies the verbatim Buck RE-unavailable incident including repeated action summary', () => {
  expect(isOnlyReapiUnavailable(incidentOutput)).toBe(true)
})

// Public CI run 41541867869, job 125607804869; GitHub's outer prefix removed.
const editorIncidentOutput = readFileSync(
  new URL('./fixtures/buck2-editor-re-unavailable.txt', import.meta.url),
  'utf8',
)

it('classifies the captured editor publisher incident with multi-action progress and build footer', () => {
  expect(isOnlyReapiUnavailable(editorIncidentOutput)).toBe(true)
  for (const output of [
    editorIncidentOutput.replace('Waiting on ', 'Unexpected failure on '),
    `${editorIncidentOutput}\nFailed to build 'root//:other (root//:platform)'`,
    `${editorIncidentOutput}\nError: compiler crashed`,
    `${editorIncidentOutput}\nAction failed: root//:compile (root//:platform) (compile app)\nerror[E0308]: mismatched types\n`,
    editorIncidentOutput.replace('Stderr: <empty>', 'Stderr: compiler crashed'),
    editorIncidentOutput.replace('BUILD ERRORS (2)', 'BUILD ERRORS (3)'),
  ])
    expect(isOnlyReapiUnavailable(output)).toBe(false)
})

// Retained dev3 real-native reader-test receipt 3eYerr, 2026-11-19:
// native stderr verbatim; only launcher preflight lines are excluded.
const testBuildIncidentOutput = readFileSync(
  new URL('./fixtures/buck2-test-build-re-unavailable.txt', import.meta.url),
  'utf8',
)

it('classifies only the complete zero-tests native test-build unavailable footer', async () => {
  expect(isOnlyReapiUnavailable(testBuildIncidentOutput)).toBe(true)
  const attempts: string[] = []
  expect(
    await runWithCacheLocalFallback({
      eligible: true,
      command: { subcommand: 'test', argumentCount: 2 },
      run: async () => {
        attempts.push('remote')
        return { exitCode: 2, output: testBuildIncidentOutput }
      },
      local: async () => {
        attempts.push('local')
        return 0
      },
      onFallback: () => {},
    }),
  ).toBe(0)
  expect(attempts).toEqual(['remote', 'local'])
})

it('rejects real test failures, nonzero test counts, mixed failures and incomplete test-build footers', async () => {
  for (const output of [
    ...['Pass', 'Fail', 'Timeout', 'Fatal', 'Skip', 'Omit', 'Infra Failure'].map((count) =>
      testBuildIncidentOutput.replace(`${count} 0`, `${count} 1`),
    ),
    testBuildIncidentOutput.replace('Build failure 1', 'Build failure 0'),
    testBuildIncidentOutput.replace('Build failure 1', 'Build failure 2'),
    testBuildIncidentOutput.replace('1 BUILDS FAILED', '2 BUILDS FAILED'),
    testBuildIncidentOutput.replace('1 BUILDS FAILED\n', ''),
    testBuildIncidentOutput.replace('NO TESTS RAN', ''),
    testBuildIncidentOutput.replace('NO TESTS RAN', 'TESTS FAILED: assertion failed'),
    testBuildIncidentOutput.replace('BUILD ERRORS (1)', 'BUILD ERRORS (2)'),
    testBuildIncidentOutput.replaceAll('The service is currently unavailable', 'Unauthenticated'),
    testBuildIncidentOutput.replaceAll('The service is currently unavailable', 'PermissionDenied'),
    testBuildIncidentOutput.replaceAll('fixture transient unavailable', 'digest mismatch'),
    testBuildIncidentOutput.replace('Stderr: <empty>', 'Stderr: compiler crashed'),
    testBuildIncidentOutput.replace('Stdout: <empty>', 'Stdout: assertion failed'),
    testBuildIncidentOutput.replace('NO TESTS RAN', 'NO TESTS RAN\nError: unknown failure'),
    testBuildIncidentOutput.replace(
      "Failed to build 'fixture//:probe (fixture//:target-platform#80c8f40843f6fe27)'",
      "Failed to build 'fixture//:other (fixture//:target-platform#80c8f40843f6fe27)'",
    ),
    `${testBuildIncidentOutput}\nerror[E0308]: mismatched types`,
    `${testBuildIncidentOutput}\nTESTS FAILED: assertion failed`,
  ]) {
    expect(isOnlyReapiUnavailable(output)).toBe(false)
    expect(
      await runWithCacheLocalFallback({
        eligible: true,
        command: { subcommand: 'test', argumentCount: 2 },
        run: async () => ({ exitCode: 2, output }),
        local: async () => {
          throw new Error('non-transient test diagnostic must not execute locally')
        },
        onFallback: () => {
          throw new Error('non-transient test diagnostic must not be classified')
        },
      }),
    ).toBe(2)
  }
})

it('rejects real-incident mutations rather than masking another action failure', async () => {
  for (const output of [
    `${incidentOutput}\nAction failed: root//:compile (root//:platform) (compile app)\nerror[E0308]: mismatched types\n`,
    incidentOutput.replace('Stderr: <empty>', 'Stderr: compiler crashed'),
    incidentOutput.replace('Stdout: <empty>', 'Stdout: tests executed and failed'),
    incidentOutput.replace('BUILD ERRORS (1)', 'BUILD ERRORS (2)'),
    incidentOutput.replace('stage: remote_action_cache', 'stage: execute'),
    incidentOutput.replaceAll('The service is currently unavailable', 'Unauthenticated'),
    incidentOutput.replaceAll('The service is currently unavailable', 'PermissionDenied'),
    incidentOutput.replaceAll('tls handshake eof', 'digest mismatch'),
    incidentOutput.replaceAll('tls handshake eof', 'checksum mismatch'),
    incidentOutput.replaceAll('tls handshake eof', 'corrupt remote data'),
    incidentOutput.replace(
      'Internal error (stage: remote_action_cache): Remote Execution Error on REClientBuilder for ReSession <none>\n',
      '',
    ),
    `${incidentOutput}\nError: a real build failure`,
    `Remote action digest: 'abc:1'\n${incidentOutput}`,
  ]) {
    expect(isOnlyReapiUnavailable(output)).toBe(false)
    const shadows: ReaderReapiUnavailableShadow[] = []
    expect(
      await runWithReaderCacheShadow({
        reader: true,
        command: { subcommand: 'build', argumentCount: 2 },
        run: async () => ({ exitCode: 1, output }),
        onShadow: (shadow) => {
          shadows.push(shadow)
        },
      }),
    ).toBe(1)
    expect(shadows).toHaveLength(0)
  }
})

it('records shadow evidence only for failed readers and always preserves the native result', async () => {
  for (const reader of [true, false]) {
    for (const exitCode of [0, 1]) {
      let runs = 0
      const shadows: ReaderReapiUnavailableShadow[] = []
      const result = await runWithReaderCacheShadow({
        reader,
        command: { subcommand: 'build', argumentCount: 2 },
        run: async () => {
          runs++
          return { exitCode, output: incidentOutput, durationMs: 47 }
        },
        onShadow: (shadow) => {
          shadows.push(shadow)
        },
      })
      expect(runs).toBe(1)
      expect(shadows).toHaveLength(reader === true && exitCode !== 0 ? 1 : 0)
      expect(result).toBe(exitCode)
      if (shadows[0] !== undefined) {
        expect(shadows[0]).toEqual({
          cause: {
            capabilitiesUnavailable: true,
            connectRetry: true,
            clientInitialization: true,
            connectUnavailable: false,
            transportMessage: 'tls-handshake-eof',
          },
          command: { subcommand: 'build', argumentCount: 2 },
          nativeExitCode: exitCode,
          durationMs: 47,
          failedActionCount: 1,
          wouldDisableRemoteCache: true,
        })
      }
    }
  }
})

it('leaves terminal stderr and interactive user-binary commands unsupervised', () => {
  const options = { reader: true, stderrIsTTY: false, cwd: '/project', env: {} }
  expect(shouldSuperviseReaderCommand({ ...options, args: ['build', '//:app'] })).toBe(true)
  for (const isolation of ['run', 'install', 'bxl']) {
    expect(
      shouldSuperviseReaderCommand({
        ...options,
        args: ['--isolation-dir', isolation, 'build', '//:app'],
      }),
    ).toBe(true)
  }
  expect(
    shouldSuperviseReaderCommand({ ...options, args: ['--isolation-dir', 'x', 'run', '//t'] }),
  ).toBe(false)
  expect(
    shouldSuperviseReaderCommand({ ...options, stderrIsTTY: true, args: ['build', '//:app'] }),
  ).toBe(false)
  expect(
    shouldSuperviseReaderCommand({ ...options, reader: false, args: ['build', '//:app'] }),
  ).toBe(false)
  for (const command of ['run', 'install', 'bxl']) {
    expect(shouldSuperviseReaderCommand({ ...options, args: [command, '//:app'] })).toBe(false)
  }
})

it('never records a shadow event for a native child terminated by a signal', async () => {
  const shadows: ReaderReapiUnavailableShadow[] = []
  expect(
    await runWithReaderCacheShadow({
      reader: true,
      command: { subcommand: 'build', argumentCount: 2 },
      run: async () => ({ exitCode: 143, signalCode: 'SIGTERM', output: reUnavailable }),
      onShadow: (shadow) => {
        shadows.push(shadow)
      },
    }),
  ).toBe(143)
  expect(shadows).toHaveLength(0)
})

it('advances short stderr writes and waits for nonblocking backpressure', async () => {
  const chunk = new TextEncoder().encode('complete diagnostic')
  const accepted: number[] = []
  let calls = 0
  let pauses = 0
  expect(
    await writeNativeStderrChunk({
      chunk,
      write: (bytes) => {
        calls++
        if (calls === 2) throw Object.assign(new Error('backpressure'), { code: 'EAGAIN' })
        const count = Math.min(3, bytes.byteLength)
        accepted.push(...bytes.subarray(0, count))
        return count
      },
      pause: async () => {
        pauses++
      },
    }),
  ).toBe(true)
  expect(new TextDecoder().decode(new Uint8Array(accepted))).toBe('complete diagnostic')
  expect(pauses).toBe(1)
})

it('caps captured stderr by bytes before decoding multibyte text and still drains output', async () => {
  const text = 'é'.repeat(131073)
  expect(text.length).toBeLessThan(262144)
  const chunk = new TextEncoder().encode(text)
  let written = 0
  expect(
    await captureNativeStderr({
      stream: (async function* () {
        yield chunk.subarray(0, 100001)
        yield chunk.subarray(100001)
      })(),
      writeChunk: async ({ chunk: bytes }) => {
        written += bytes.byteLength
        return true
      },
    }),
  ).toBeUndefined()
  expect(written).toBe(chunk.byteLength)
})

it('drains native stderr after a tee failure instead of replacing the child result', async () => {
  let drained = 0
  expect(
    await captureNativeStderr({
      stream: (async function* () {
        for (let index = 0; index < 3; index++) {
          drained++
          yield new Uint8Array([65])
        }
      })(),
      writeChunk: async () => {
        throw new Error('closed stderr')
      },
    }),
  ).toBeUndefined()
  expect(drained).toBe(3)
})

it('cancels a stalled stderr backpressure retry and disables capture on termination', async () => {
  const cancelled = new AbortController()
  let attempts = 0
  let drained = 0
  const output = await captureNativeStderr({
    signal: cancelled.signal,
    stream: (async function* () {
      for (let index = 0; index < 3; index++) {
        drained++
        yield new Uint8Array([65])
      }
    })(),
    writeChunk: ({ chunk, signal }) =>
      writeNativeStderrChunk({
        chunk,
        signal,
        write: () => {
          attempts++
          cancelled.abort()
          throw Object.assign(new Error('consumer stopped reading'), { code: 'EAGAIN' })
        },
      }),
  })
  expect(output).toBeUndefined()
  expect(attempts).toBe(1)
  expect(drained).toBe(3)
})

it('admits readers and explicit optional writers but never trusted qualification', () => {
  for (const uploads of ['false', 'true']) {
    const values = { 'buck2.remote_cache_enabled': 'true', 'buck2.allow_cache_uploads': uploads }
    expect(cacheLocalFallbackEligible({ values, env: {} })).toBe(uploads === 'false')
    expect(cacheLocalFallbackEligible({ values, env: { BUCK2_CACHE_WRITE_OPTIONAL: '1' } })).toBe(
      true,
    )
    for (const env of [
      { BUCK2_CACHE_TRUSTED_QUALIFICATION: '1' },
      { GITHUB_JOB: 'trusted-buck2-remote-cache-proof' },
    ])
      expect(
        cacheLocalFallbackEligible({
          values,
          env: { ...env, BUCK2_CACHE_WRITE_OPTIONAL: '1' },
        }),
      ).toBe(false)
    expect(
      cacheLocalFallbackEligible({
        values: { ...values, 'buck2.remote_cache_enabled': 'false' },
        env: { BUCK2_CACHE_WRITE_OPTIONAL: '1' },
      }),
    ).toBe(false)
  }
})

it('replays one classified failure exactly once and returns the local result including failure', async () => {
  for (const localExit of [0, 7]) {
    const calls: string[] = []
    expect(
      await runWithCacheLocalFallback({
        eligible: true,
        command: { subcommand: 'build', argumentCount: 2 },
        run: async () => {
          calls.push('native')
          return { exitCode: 1, output: reUnavailable }
        },
        onFallback: (value) => {
          calls.push('classified')
          expect(value.nativeExitCode).toBe(1)
          expect(value.cause.transportMessage).toBe('tls-handshake-eof')
        },
        local: async () => {
          calls.push('local')
          return localExit
        },
      }),
    ).toBe(localExit)
    expect(calls).toEqual(['native', 'classified', 'local'])
  }
})

it('never replays disabled, signalled, unknown, mixed, auth, integrity or unforwarded output', async () => {
  for (const result of [
    { exitCode: 0, output: reUnavailable },
    { exitCode: 1, output: reUnavailable, signalCode: 'SIGTERM' },
    { exitCode: 1, output: '' }, // overflow/interrupted forwarding intentionally discard capture
    { exitCode: 1, output: `${reUnavailable}\nerror TS2322` },
    { exitCode: 1, output: `${reUnavailable}\nError: permission denied` },
    { exitCode: 1, output: `${reUnavailable}\nError: digest mismatch` },
  ]) {
    let invocations = 0
    expect(
      await runWithCacheLocalFallback({
        eligible: true,
        command: { subcommand: 'test', argumentCount: 2 },
        run: async () => {
          invocations++
          return result
        },
        onFallback: () => {
          throw new Error('unexpected fallback')
        },
        local: async () => {
          invocations++
          return 0
        },
      }),
    ).toBe(result.exitCode)
    expect(invocations).toBe(1)
  }
})

it('pins local replay flags before payload and keeps original native identity sinks intact', () => {
  const options = { cwd: root, env: {}, buildId: 'local-id' }
  expect(
    localCacheReplayArguments({
      ...options,
      args: [
        'build',
        '//:app',
        '--write-build-id',
        'original-id',
        '--event-log=original-events',
        '--reuse-current-config',
        '--',
        '//:other',
      ],
    }),
  ).toEqual([
    'build',
    '//:app',
    '--write-build-id',
    'original-id.local-local-id',
    '--event-log=original-events.local-local-id',
    '--local-only',
    '--no-remote-cache',
    '--',
    '//:other',
  ])
  expect(
    localCacheReplayArguments({
      ...options,
      args: ['test', '//:tests', '--', '--event-log=literal', '--remote-only', '@literal'],
    }),
  ).toEqual([
    'test',
    '//:tests',
    '--local-only',
    '--no-remote-cache',
    '--',
    '--event-log=literal',
    '--remote-only',
    '@literal',
  ])
  for (const args of [
    ['run', '//:app'],
    ['install', '//:app'],
    ['bxl', '//:main'],
    ['build', '--remote-only', '//:app'],
  ])
    expect(localCacheReplayArguments({ ...options, args })).toBeUndefined()
})

it('keeps the executed literal snapshot when a supported argfile is rewritten after admission', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'buck-invocation-snapshot-'))
  try {
    const path = join(cwd, 'mutable.args')
    writeFileSync(path, '--isolation-dir\nv2\nbuild\n//:quick\n')
    const admitted = resolveManagedInvocation({ args: ['@mutable.args'], cwd, env: {} })
    writeFileSync(path, '--isolation-dir\neditor-publication\nclean\n')
    expect(admitted).toEqual({
      isolation: 'v2',
      args: ['--isolation-dir', 'v2', 'build', '//:quick'],
      nativeArgumentCount: 4,
    })
    expect(resolveManagedInvocation({ args: ['@mutable.args'], cwd, env: {} }).isolation).toBe(
      'editor-publication',
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

it('never lets a trailing run payload override native isolation selection', () => {
  const args = ['run', '//:tool', 'payload', '--isolation-dir', 'v2']
  const env = { BUCK_ISOLATION_DIR: 'editor-publication' }
  expect(resolveManagedInvocation({ args, cwd: root, env })).toEqual({
    isolation: 'editor-publication',
    args,
    nativeArgumentCount: 2,
  })
  expect(
    resolveManagedInvocation({
      args: ['run', '--unfamiliar-option', '//:tool', 'payload'],
      cwd: root,
      env,
    }).isolation,
  ).toBe('editor-publication')
  expect(() =>
    resolveManagedInvocation({
      args: ['run', '--unfamiliar-option', '//:tool', '--isolation-dir', 'v2'],
      cwd: root,
      env,
    }),
  ).toThrow('ambiguous run option')
})
