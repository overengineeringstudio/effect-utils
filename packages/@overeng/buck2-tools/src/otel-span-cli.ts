import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

/**
 * OTEL command instrumentation for the procedural buck2-tools scripts.
 *
 * Mirrors the shell gates of `nix/devenv-modules/tasks/lib/trace.nix`: command
 * wrapping and span emission engage only when span delivery is configured
 * (spool dir or OTLP endpoint), an `otel-span` CLI is resolvable on PATH, and a
 * well-formed W3C traceparent from the wrapping task span is present. Without
 * all three, every helper returns its input unchanged and emits nothing, so
 * these scripts behave identically in environments without OTEL.
 */

const traceparentPattern = /^00-[0-9a-fA-F]{32}-[0-9a-fA-F]{16}-[0-9a-fA-F]{2}$/

/** Attribute carried on an emitted span; typed values map to otel-span typed flags. */
export type OtelSpanAttribute = readonly [key: string, value: string | number | boolean]

const deliveryConfigured = (): boolean =>
  (process.env.OTELITE_HTTP_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '') !== '' ||
  existsSync(process.env.OTEL_SPAN_SPOOL_DIR ?? '')

/** OTEL task trace context gate; equals trace.nix `otelTraceContextActive`. */
export const otelTraceContextActive = (): boolean =>
  deliveryConfigured() === true &&
  traceparentPattern.test(process.env.OTEL_TASK_TRACEPARENT ?? process.env.TRACEPARENT ?? '')

const otelSpanPath = (): string | undefined => {
  if (otelTraceContextActive() !== true) return undefined
  // The wrapping task shell resolves otel-span through OTEL_SPAN_BIN first, exactly
  // like trace.nix's `${OTEL_SPAN_BIN:-otel-span}` invocation.
  const declared = process.env.OTEL_SPAN_BIN
  if (declared !== undefined && declared !== '') {
    try {
      accessSync(declared, constants.X_OK)
      return declared
    } catch {
      return undefined
    }
  }
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (directory === '') continue
    const candidate = join(directory, 'otel-span')
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Wraps one concrete command argv in an `otel-span run` command span beneath the
 * active task span, exactly like a trace.nix `trace.instr` prelude. Returns the
 * argv unchanged whenever no OTEL task trace context is active.
 */
export const withOtelSpan = ({
  name,
  label,
  attributes,
  argv,
}: {
  readonly name: string
  readonly label: string
  readonly attributes: readonly OtelSpanAttribute[]
  readonly argv: readonly string[]
}): readonly string[] => {
  const otelSpan = otelSpanPath()
  if (otelSpan === undefined) return argv
  return [
    otelSpan,
    'run',
    'effect-utils-devenv',
    name,
    ...attributes.flatMap(([key, value]) => ['--attr', `${key}=${value}`]),
    '--attr',
    `span.label=${label}`,
    '--',
    ...argv,
  ]
}

const epochNanoseconds = (milliseconds: number): string =>
  String(BigInt(Math.round(milliseconds * 1_000_000)))

/**
 * Emits one completed span with explicit boundaries via `otel-span emit-span`.
 * Fire-and-forget: delivery problems must never affect the publishing process.
 */
export const emitCompletedSpan = ({
  name,
  label,
  attributes,
  startedAtMs,
  endedAtMs,
}: {
  readonly name: string
  readonly label: string
  readonly attributes: readonly OtelSpanAttribute[]
  /** Epoch milliseconds (for example `performance.timeOrigin + performance.now()`). */
  readonly startedAtMs: number
  readonly endedAtMs: number
}): void => {
  const otelSpan = otelSpanPath()
  if (otelSpan === undefined) return
  spawnSync(
    otelSpan,
    [
      'emit-span',
      'effect-utils-devenv',
      name,
      '--start-time-ns',
      epochNanoseconds(startedAtMs),
      '--end-time-ns',
      epochNanoseconds(endedAtMs),
      ...attributes.flatMap(([key, value]) =>
        typeof value === 'number'
          ? ['--attr-int', `${key}=${Math.round(value)}`]
          : typeof value === 'boolean'
            ? ['--attr-bool', `${key}=${value}`]
            : ['--attr-string', `${key}=${value}`],
      ),
      '--attr-string',
      `span.label=${label}`,
    ],
    { stdio: 'ignore' },
  )
}
