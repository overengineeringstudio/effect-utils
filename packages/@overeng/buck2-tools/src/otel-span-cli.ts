import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

/**
 * OTEL span emission for the procedural buck2-tools scripts.
 *
 * Mirrors the shell gates of `nix/devenv-modules/tasks/lib/trace.nix`: span
 * emission engages only when span delivery is configured (spool dir or OTLP
 * endpoint), an `otel-span` CLI is resolvable, and a well-formed W3C
 * traceparent from the wrapping task span is present. Without all three,
 * nothing is emitted, so these scripts behave identically in environments
 * without OTEL. Emission is strictly best effort: the real command always runs
 * unwrapped and its exit status is never influenced by telemetry delivery.
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

const epochNanoseconds = (milliseconds: number): string =>
  String(BigInt(Math.round(milliseconds * 1_000_000)))

/**
 * Emits one completed span with explicit boundaries via `otel-span emit-span`.
 * Fire-and-forget: delivery problems must never affect the publishing process,
 * so every failure of the CLI is swallowed and nothing is returned.
 */
export const emitCompletedSpan = ({
  name,
  label,
  attributes,
  startedAtMs,
  endedAtMs,
  exitCode = 0,
}: {
  readonly name: string
  readonly label: string
  readonly attributes: readonly OtelSpanAttribute[]
  /** Epoch milliseconds (for example `performance.timeOrigin + performance.now()`). */
  readonly startedAtMs: number
  readonly endedAtMs: number
  /** Real command exit status recorded on the span; nonzero marks the span error. */
  readonly exitCode?: number
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
      '--attr-int',
      `exit.code=${exitCode}`,
      '--status-code',
      exitCode === 0 ? 'ok' : 'error',
      '--attr-string',
      `span.label=${label}`,
    ],
    { stdio: 'ignore' },
  )
}
