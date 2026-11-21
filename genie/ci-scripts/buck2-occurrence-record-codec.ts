import { boolean, field, integer, list, text } from './buck2-action-evidence-codec.ts'

export interface RetainedOccurrenceFile {
  readonly name: string
  readonly body: string
}

type Attributes = Map<string, string | boolean>
export type Census = {
  id: string
  phase: string
  host: string
  at: bigint
  build: string | null
  run: string
  lane: string | null
  error: boolean
}
export type Capture = {
  build: string
  root: string | null
  attrs: Attributes
  rows: Map<string, string>
  values: Map<string, unknown>
  conflicts: Set<string>
  incomplete: boolean
}
const resourceKeys = [
  'host.name',
  'host.arch',
  'os.type',
  'buck2.root_id',
  'cicd.pipeline.run.id',
  'vcs.provider.name',
  'vcs.change.id',
  'vcs.ref.head.revision',
  'vcs.ref.base.revision',
  'buck2.vcs.merge.revision',
  'buck2.vcs.change.is_fork',
]
export const actionKeys = [
  'buck2.occurrence_id',
  'buck2.action_digest',
  'buck2.category',
  'buck2.target',
  'buck2.configuration',
  'buck2.execution_kind',
  'buck2.execution_outcome',
  'buck2.failed',
  'buck2.unclosed',
  'buck2.total_bytes',
  'buck2.duration_ns',
  'buck2.execution_ns',
  'buck2.queue_ns',
  'buck2.action_host',
]
export const fail = (): never => {
  throw new Error('Invalid retained occurrence evidence')
}
export const get =
  (value: unknown) =>
  (key: string): unknown =>
    field({ value, key })
const shape = ({ value, keys }: { value: unknown; keys: readonly string[] }): void => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) === true ||
    Object.keys(value).some((key) => keys.includes(key) === false) === true
  )
    fail()
}
export const ns = (value: unknown): bigint => {
  const raw = text(value)
  if (/^(0|[1-9][0-9]*)$/.test(raw) === false) return fail()
  return BigInt(raw)
}
const nullableText = (value: unknown): string | null => (value === null ? null : text(value))
export const safe = (value: bigint): number | null =>
  value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= 0n ? Number(value) : null
export const milliseconds = (value: bigint): number | null => safe(value / 1_000_000n)
export const attributes = ({
  value,
  keys,
}: {
  value: unknown
  keys: readonly string[]
}): Attributes => {
  const result: Attributes = new Map()
  for (const entry of list(value)) {
    shape({ value: entry, keys: ['key', 'value'] })
    const key = text(get(entry)('key'))
    if (keys.includes(key) === false) fail()
    const typed = get(entry)('value')
    const kind =
      key.endsWith('is_fork') === true || ['buck2.failed', 'buck2.unclosed'].includes(key) === true
        ? 'boolValue'
        : [
              'buck2.total_bytes',
              'buck2.duration_ns',
              'buck2.execution_ns',
              'buck2.queue_ns',
            ].includes(key) === true
          ? 'intValue'
          : 'stringValue'
    shape({ value: typed, keys: [kind] })
    const raw = get(typed)(kind)
    const decoded =
      kind === 'boolValue' ? boolean(raw) : kind === 'intValue' ? ns(raw).toString() : text(raw)
    if (result.has(key) === true && result.get(key) !== decoded) fail()
    result.set(key, decoded)
  }
  return result
}
export const attr =
  (attrs: Attributes) =>
  (key: string): string | null => {
    const value = attrs.get(key)
    return typeof value === 'string' ? value : null
  }

interface DecodedOccurrenceFiles {
  manifests: Map<string, string>
  census: Map<string, Census>
  captures: Map<string, Capture[]>
}
export const decodeOccurrenceFiles = ({
  files,
  hosts,
  start,
  gaps,
}: {
  files: readonly RetainedOccurrenceFile[]
  hosts: ReadonlySet<string>
  start: bigint
  gaps: Set<string>
}): DecodedOccurrenceFiles => {
  const manifests = new Map<string, string>()
  const census = new Map<string, Census>()
  const captures = new Map<string, Capture[]>()
  for (const file of files) {
    if (file.body.endsWith('\n') === false) gaps.add(`${file.name}:truncated-file`)
    const lines = file.body.split('\n')
    lines.pop()
    let capture: Capture | undefined
    for (const [index, line] of lines.entries()) {
      try {
        const value: unknown = JSON.parse(line)
        const read = get(value)
        switch (read('type')) {
          case 'manifest': {
            shape({
              value,
              keys: ['type', 'host', 'enrolled_at_ns', 'retention_seconds', 'scope', 'coverage'],
            })
            if (index !== 0 || lines.length !== 1) fail()
            const host = text(read('host'))
            if (hosts.has(host) === false) gaps.add(`${host}:unexpected-host`)
            if (ns(read('enrolled_at_ns')) > start) gaps.add(`${host}:late-enrollment`)
            if (integer(read('retention_seconds')) < 2_592_000)
              gaps.add(`${host}:retention-under-30d`)
            if (
              read('scope') !== 'supported-entrypoints' ||
              read('coverage') !== 'unknown-until-reconciled'
            )
              fail()
            const canonical = JSON.stringify([
              host,
              read('enrolled_at_ns'),
              read('retention_seconds'),
            ])
            if (manifests.has(host) === true && manifests.get(host) !== canonical)
              gaps.add(`${host}:conflicting-manifest`)
            manifests.set(host, canonical)
            break
          }
          case 'invocation': {
            shape({
              value,
              keys: [
                'type',
                'phase',
                'invocation_id',
                'host',
                'timestamp_ns',
                'build_id',
                'exit_code',
                'capture_error',
                'lane',
                'run_id',
              ],
            })
            if (index !== 0 || lines.length !== 1) fail()
            const phase = text(read('phase'))
            if (phase !== 'open' && phase !== 'terminal') fail()
            const exit = read('exit_code')
            if (exit !== null && (typeof exit !== 'number' || Number.isSafeInteger(exit) === false))
              fail()
            const entry: Census = {
              id: text(read('invocation_id')),
              phase,
              host: text(read('host')),
              at: ns(read('timestamp_ns')),
              build: nullableText(read('build_id')),
              run: text(read('run_id')),
              lane: nullableText(read('lane')),
              error: boolean(read('capture_error')),
            }
            if (entry.lane !== null && entry.lane !== 'supported-entrypoint/local') fail()
            const key = JSON.stringify([entry.id, phase])
            const previous = census.get(key)
            if (
              previous !== undefined &&
              JSON.stringify({ ...previous, at: previous.at.toString() }) !==
                JSON.stringify({ ...entry, at: entry.at.toString() })
            )
              gaps.add(`${entry.id}:conflicting-census`)
            census.set(key, entry)
            break
          }
          case 'conversion': {
            shape({
              value,
              keys: [
                'type',
                'build_id',
                'root_id',
                'resource_attributes',
                'truncated',
                'stop_reason',
                'unknown_fields',
                'action_count',
              ],
            })
            if (index !== 0) fail()
            const truncated = boolean(read('truncated'))
            const stop = nullableText(read('stop_reason'))
            const unknown = integer(read('unknown_fields'))
            const count = integer(read('action_count'))
            capture = {
              build: text(read('build_id')),
              root: nullableText(read('root_id')),
              attrs: attributes({ value: read('resource_attributes'), keys: resourceKeys }),
              rows: new Map(),
              values: new Map(),
              conflicts: new Set(),
              incomplete:
                truncated === true ||
                stop !== null ||
                unknown > 0 ||
                count !== lines.length - 1 ||
                file.body.endsWith('\n') === false,
            }
            const existing = captures.get(capture.build) ?? []
            existing.push(capture)
            captures.set(capture.build, existing)
            break
          }
          case 'occurrence': {
            shape({
              value,
              keys: ['type', 'build_id', 'span_id', 'start_ns', 'end_ns', 'ended', 'attributes'],
            })
            if (capture === undefined || text(read('build_id')) !== capture.build) fail()
            const span = ns(read('span_id')).toString()
            const attrs = attributes({ value: read('attributes'), keys: actionKeys })
            const canonical = JSON.stringify([
              span,
              ns(read('start_ns')).toString(),
              ns(read('end_ns')).toString(),
              boolean(read('ended')),
              Array.from(attrs).toSorted(([a], [b]) => a.localeCompare(b)),
            ])
            const previous = capture.rows.get(span)
            if (previous !== undefined) {
              gaps.add(`${capture.build}:duplicate-span`)
              if (previous !== canonical) {
                gaps.add(`${capture.build}:${span}:conflicting-capture`)
                capture.conflicts.add(span)
                capture.incomplete = true
              }
            }
            capture.rows.set(span, canonical)
            capture.values.set(span, value)
            break
          }
          default:
            fail()
        }
      } catch {
        gaps.add(`${file.name}:${index + 1}:malformed-record`)
        if (capture !== undefined) capture.incomplete = true
      }
    }
  }
  return { manifests, census, captures }
}
