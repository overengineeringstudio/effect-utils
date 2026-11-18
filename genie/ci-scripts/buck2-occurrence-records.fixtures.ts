import { reconcileOccurrenceRecords } from './buck2-occurrence-records.ts'

export const windowStartMs = 1_800_000_000_000
export const windowEndMs = windowStartMs + 86_400_000
export const start = BigInt(windowStartMs) * 1_000_000n
const jsonl = (values: readonly unknown[]): string =>
  `${values.map((value) => JSON.stringify(value)).join('\n')}\n`
export const stringAttribute = ({ key, value }: { key: string; value: string }) => ({
  key,
  value: { stringValue: value },
})
export const manifest = ({
  host = 'host-a',
  enrolled = start,
  retention = 2_592_000,
}: { host?: string; enrolled?: bigint; retention?: number } = {}) => ({
  name: `${host}-manifest`,
  body: jsonl([
    {
      type: 'manifest',
      host,
      enrolled_at_ns: enrolled.toString(),
      retention_seconds: retention,
      scope: 'supported-entrypoints',
      coverage: 'unknown-until-reconciled',
    },
  ]),
})
export const census = ({
  phase,
  build = 'build-a',
  host = 'host-a',
  error = false,
  run = 'run-a',
}: {
  phase: 'open' | 'terminal'
  build?: string | null
  host?: string
  error?: boolean
  run?: string
}) => ({
  name: `${host}-${build}-${phase}`,
  body: jsonl([
    {
      type: 'invocation',
      phase,
      invocation_id: `${host}-${build}`,
      host,
      timestamp_ns: (start + (phase === 'open' ? 0n : 10_000_000n)).toString(),
      build_id: phase === 'open' ? null : build,
      exit_code: phase === 'open' ? null : 0,
      capture_error: error,
      lane: 'supported-entrypoint/local',
      run_id: run,
    },
  ]),
})
export const occurrence = ({
  build = 'build-a',
  span = '1',
  ended = start + 5_000_001n,
  outcome = 'local-exec',
  failed = false,
  bytes = '100',
  closed = true,
}: {
  build?: string
  span?: string
  ended?: bigint
  outcome?: string
  failed?: boolean
  bytes?: string
  closed?: boolean
} = {}) => ({
  type: 'occurrence',
  build_id: build,
  span_id: span,
  start_ns: start.toString(),
  end_ns: ended.toString(),
  ended: closed,
  attributes: [
    stringAttribute({ key: 'buck2.occurrence_id', value: `${build}-${span}` }),
    stringAttribute({ key: 'buck2.action_digest', value: 'digest-shared' }),
    stringAttribute({ key: 'buck2.execution_outcome', value: outcome }),
    { key: 'buck2.failed', value: { boolValue: failed } },
    { key: 'buck2.total_bytes', value: { intValue: bytes } },
  ],
})
export const conversion = ({
  build = 'build-a',
  host = 'host-a',
  root = 'root-a',
  run = 'run-a',
  rows = [occurrence({ build })],
  truncated = false,
  unknown = 0,
}: {
  build?: string
  host?: string
  root?: string | null
  run?: string
  rows?: readonly unknown[]
  truncated?: boolean
  unknown?: number
} = {}) => ({
  name: `${build}-conversion`,
  body: jsonl([
    {
      type: 'conversion',
      build_id: build,
      root_id: root,
      resource_attributes: [
        stringAttribute({ key: 'host.name', value: host }),
        stringAttribute({ key: 'cicd.pipeline.run.id', value: run }),
      ],
      truncated,
      stop_reason: null,
      unknown_fields: unknown,
      action_count: rows.length,
    },
    ...rows,
  ]),
})
export const filesFor = ({
  build = 'build-a',
  host = 'host-a',
  root = 'root-a',
}: { build?: string; host?: string; root?: string } = {}) => [
  manifest({ host }),
  census({ phase: 'open', build, host }),
  census({ phase: 'terminal', build, host }),
  conversion({ build, host, root }),
]
export const reconcile = ({
  files = filesFor(),
  expectedHosts = ['host-a'],
}: { files?: readonly { name: string; body: string }[]; expectedHosts?: readonly string[] } = {}) =>
  reconcileOccurrenceRecords({ files, expectedHosts, windowStartMs, windowEndMs })
