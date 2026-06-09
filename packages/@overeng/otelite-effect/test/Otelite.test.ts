import { access } from 'node:fs/promises'

import { NodeContext } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Layer } from 'effect'

import { Otelite, OteliteChildFailed, OteliteCliError } from '../src/mod.ts'

/** Real otelite binary (from `PATH`, see README) + Node platform layer. */
const TestLayer = Otelite.Default.pipe(Layer.provideMerge(NodeContext.layer))

const tracesFixture = new URL('./fixtures/traces.ndjson', import.meta.url).pathname

describe('Otelite', () => {
  it.scoped('run() yields a decoded otelite.summary/v1 for a successful child', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const summary = yield* otelite.run({ command: ['true'] })

      expect(summary.schema).toBe('otelite.summary/v1')
      expect(summary.child).toEqual({ argv: ['true'], exit_code: 0 })
      expect(summary.counts).toEqual({ spans: 0, metrics: 0, logs: 0 })
      expect(summary.out).toMatch(/otelite-/)
      expect(summary.endpoints.http).toMatch(/^http:\/\//)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.scoped('a non-zero child surfaces as the tagged OteliteChildFailed error', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const exit = yield* otelite.run({ command: ['false'] }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const error = yield* otelite.run({ command: ['false'] }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(OteliteChildFailed)
      expect((error as OteliteChildFailed).exitCode).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.scoped('the scoped out-dir is released after the run scope closes', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      // Capture the minted dir from within a child scope; the finalizer removes
      // it when that inner scope closes.
      const out = yield* Effect.scoped(
        otelite.run({ command: ['true'] }).pipe(Effect.map((s) => s.out)),
      )
      const exists = yield* Effect.promise(() =>
        access(out)
          .then(() => true)
          .catch(() => false),
      )
      expect(exists).toBe(false)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('inspect() over a committed traces fixture yields typed span rows', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const rows = yield* otelite.inspect({ src: tracesFixture, signal: 'traces' })

      expect(rows).toHaveLength(2)
      expect(rows.every((r) => r.schema === 'otelite.span/v1')).toBe(true)
      const op1 = rows.find((r) => r.name === 'op1')!
      expect(op1.service).toBe('svc-a')
      expect(op1.attrs).toEqual({ 'http.method': 'GET' })
      expect(op1.parent_span_id).toBeNull()
      expect(op1.duration_ms).toBe(5)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('inspect(--name) narrows the flat rows', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const rows = yield* otelite.inspect({ src: tracesFixture, signal: 'traces', name: 'op2' })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.name).toBe('op2')
      expect(rows[0]!.parent_span_id).toBe('aaaaaaaaaaaaaaaa')
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('inspect(summary) yields the typed otelite.trace-summary/v1 report', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const report = yield* otelite.inspect({
        src: tracesFixture,
        signal: 'traces',
        summary: true,
      })
      expect(report.schema).toBe('otelite.trace-summary/v1')
      expect(report.span_count).toBe(2)
      expect(report.root_service).toBe('svc-a')
      expect(report.duration_ms).toBe(5)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('an inspect source that is missing surfaces as OteliteCliError', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const error = yield* otelite
        .inspect({ src: '/nonexistent/otelite-effect-missing.ndjson', signal: 'traces' })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(OteliteCliError)
      expect((error as OteliteCliError).reason).toBe('no-input')
      expect((error as OteliteCliError).exitCode).toBe(66)
    }).pipe(Effect.provide(TestLayer)),
  )
})
