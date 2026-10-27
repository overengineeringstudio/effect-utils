import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

import {
  gateCgroupRelation,
  gateDaemonStopDecision,
  gateScopeIdentity,
  isOnlyReapiUnavailable,
  runWithReaderCacheFallback,
} from './buck2-entrypoint.ts'

const root = '/project/root'
const isolation = 'owned'
const idle = { project_root: root, isolation_dir: isolation, active_commands: [] }

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
    let reruns = 0
    expect(
      await runWithReaderCacheFallback({
        reader: true,
        run: async () => ({ exitCode: 1, output }),
        fallback: async () => {
          reruns++
          return 0
        },
      }),
    ).toBe(1)
    expect(reruns).toBe(0)
  }
})

it('never reruns writers or successes and makes a failed rerun final', async () => {
  for (const reader of [true, false]) {
    for (const exitCode of [0, 1]) {
      let runs = 0
      let reruns = 0
      const result = await runWithReaderCacheFallback({
        reader,
        run: async () => {
          runs++
          return { exitCode, output: reUnavailable }
        },
        fallback: async () => {
          reruns++
          return 17
        },
      })
      expect(runs).toBe(1)
      expect(reruns).toBe(reader === true && exitCode !== 0 ? 1 : 0)
      expect(result).toBe(reruns === 1 ? 17 : exitCode)
    }
  }
})
