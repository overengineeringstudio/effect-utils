import * as ChildProcess from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emitCompletedSpanAsync, otelTraceContextActive } from './otel-span-cli.ts'

const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'

const activeDirectories: string[] = []
const exporters: ChildProcess.ChildProcess[] = []
const exporterExits: Promise<{
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}>[] = []

/** Join real deferred subprocess close events only in tests, never in a runtime caller. */
const settleExporters = async (): Promise<void> => {
  const turn = Promise.withResolvers<void>()
  setImmediate(turn.resolve)
  await turn.promise
  await Promise.all(exporterExits)
}

/** Installs a capturing fake `otel-span` executable plus an active trace context. */
const activateFakeOtelSpan = (): { readonly bin: string; readonly captures: () => string[] } => {
  const directory = mkdtempSync(join(tmpdir(), 'otel-span-cli-'))
  const bin = join(directory, 'otel-span')
  const capture = join(directory, 'captured.txt')
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(capture)}\n`)
  chmodSync(bin, 0o755)
  process.env.PATH = `${directory}:${process.env.PATH ?? ''}`
  process.env.TRACEPARENT = traceparent
  process.env.OTEL_SPAN_SPOOL_DIR = directory
  // CI exports OTEL_SPAN_BIN and endpoint vars; pin every gate input hermetically.
  delete process.env.OTEL_SPAN_BIN
  delete process.env.OTELITE_HTTP_ENDPOINT
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete process.env.OTEL_TASK_TRACEPARENT
  activeDirectories.push(directory)
  return {
    bin,
    captures: () =>
      existsSync(capture) === true
        ? readFileSync(capture, 'utf8')
            .split('\n')
            .filter((line) => line.length > 0)
        : [],
  }
}

describe('otel span cli', () => {
  const saved = {
    PATH: process.env.PATH,
    TRACEPARENT: process.env.TRACEPARENT,
    OTEL_TASK_TRACEPARENT: process.env.OTEL_TASK_TRACEPARENT,
    OTEL_SPAN_SPOOL_DIR: process.env.OTEL_SPAN_SPOOL_DIR,
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    OTELITE_HTTP_ENDPOINT: process.env.OTELITE_HTTP_ENDPOINT,
    OTEL_SPAN_BIN: process.env.OTEL_SPAN_BIN,
  }
  beforeEach(() => {
    const nativeSpawn = ChildProcess.spawn
    vi.spyOn(ChildProcess, 'spawn').mockImplementation((...args) => {
      const child = Reflect.apply(nativeSpawn, ChildProcess, args) as ChildProcess.ChildProcess
      exporters.push(child)
      const exited = Promise.withResolvers<{
        readonly code: number | null
        readonly signal: NodeJS.Signals | null
      }>()
      child.once('close', (code, signal) => exited.resolve({ code, signal }))
      exporterExits.push(exited.promise)
      return child
    })
  })
  afterEach(async () => {
    await settleExporters()
    vi.restoreAllMocks()
    exporters.length = 0
    exporterExits.length = 0
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    for (const directory of activeDirectories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  it('emits nothing without an active OTEL task trace context', () => {
    delete process.env.TRACEPARENT
    delete process.env.OTEL_TASK_TRACEPARENT
    delete process.env.OTEL_SPAN_SPOOL_DIR
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    delete process.env.OTELITE_HTTP_ENDPOINT
    expect(otelTraceContextActive()).toBe(false)
    // The gate short-circuits before any executable is resolved or spawned.
    expect(
      emitCompletedSpanAsync({
        name: 'editor-view.phases',
        label: 'phases demo',
        attributes: [],
        startedAtMs: 0,
        endedAtMs: 1,
      }),
    ).toBe(false)
  })

  it('rejects malformed traceparents even when delivery is configured', () => {
    const directory = mkdtempSync(join(tmpdir(), 'otel-span-cli-'))
    activeDirectories.push(directory)
    process.env.OTEL_SPAN_SPOOL_DIR = directory
    process.env.TRACEPARENT = '00-not-a-traceparent'
    delete process.env.OTEL_TASK_TRACEPARENT
    expect(otelTraceContextActive()).toBe(false)
  })

  it('marks a failed command exit as an error span without throwing', async () => {
    const fake = activateFakeOtelSpan()
    expect(
      emitCompletedSpanAsync({
        name: 'buck2.build',
        label: 'buck2 build editor view inputs',
        attributes: [],
        startedAtMs: 2_000,
        endedAtMs: 2_500,
        exitCode: 17,
      }),
    ).toBe(true)
    await settleExporters()
    const captured = fake.captures().join('\n')
    expect(captured).toContain('emit-span effect-utils-devenv buck2.build')
    expect(captured).toContain('--attr-int exit.code=17')
    expect(captured).toContain('--status-code error')
  })

  it('prefers OTEL_SPAN_BIN over the PATH lookup, like the task shell', async () => {
    const fake = activateFakeOtelSpan()
    const declared = mkdtempSync(join(tmpdir(), 'otel-span-cli-'))
    activeDirectories.push(declared)
    const declaredCapture = join(declared, 'captured.txt')
    const declaredBin = join(declared, 'otel-span')
    writeFileSync(
      declaredBin,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(declaredCapture)}\n`,
    )
    chmodSync(declaredBin, 0o755)
    process.env.OTEL_SPAN_BIN = declaredBin
    expect(
      emitCompletedSpanAsync({
        name: 'editor-view.phases',
        label: 'phases demo',
        attributes: [],
        startedAtMs: 0,
        endedAtMs: 1,
      }),
    ).toBe(true)
    await settleExporters()
    expect(readFileSync(declaredCapture, 'utf8')).toContain(
      'emit-span effect-utils-devenv editor-view.phases',
    )
    expect(fake.captures()).toHaveLength(0)
  })

  it('emits one completed span with typed phase attributes', async () => {
    const fake = activateFakeOtelSpan()
    expect(
      emitCompletedSpanAsync({
        name: 'editor-view.phases',
        label: 'phases demo',
        attributes: [
          ['phase.fingerprint.ms', 101],
          ['snapshot.created', true],
          ['package.path', 'packages/@overeng/demo'],
        ],
        startedAtMs: 1_000,
        endedAtMs: 1_250,
      }),
    ).toBe(true)
    await settleExporters()
    const captured = fake.captures().join('\n')
    expect(captured).toContain('emit-span effect-utils-devenv editor-view.phases')
    expect(captured).toContain('--start-time-ns 1000000000')
    expect(captured).toContain('--end-time-ns 1250000000')
    expect(captured).toContain('--attr-int phase.fingerprint.ms=101')
    expect(captured).toContain('--attr-bool snapshot.created=true')
    expect(captured).toContain('--attr-string package.path=packages/@overeng/demo')
    expect(captured).toContain('--attr-string span.label=phases demo')
  })

  it('shares a drop-on-full bound across span kinds and reopens slots only after reaping', async () => {
    const fake = activateFakeOtelSpan()
    writeFileSync(
      fake.bin,
      `#!${process.execPath}\nimport { watch } from 'node:fs'\nwatch(${JSON.stringify(fake.bin)}, () => {})\nawait Promise.withResolvers().promise\n`,
    )
    const names = [
      'editor-view.host-budget',
      'editor-view.phases',
      'buck2.build',
      'editor-view.publish',
    ]
    const admitted = [...names, ...names].map((name) =>
      emitCompletedSpanAsync({
        name,
        label: 'bounded',
        attributes: [],
        startedAtMs: 0,
        endedAtMs: 1,
      }),
    )
    expect(admitted).toEqual([true, true, true, true, false, false, false, false])
    // Even subprocess startup is deferred past the synchronous caller.
    expect(exporters).toHaveLength(0)
    await settleExporters()
    expect(exporters.map((child) => child.spawnargs[3])).toEqual(names)
    expect(await Promise.all(exporterExits)).toEqual(
      names.map(() => ({ code: null, signal: 'SIGKILL' })),
    )
    writeFileSync(fake.bin, '#!/bin/sh\nexit 0\n')
    expect(
      emitCompletedSpanAsync({
        name: 'editor-view.phases',
        label: 'reaped',
        attributes: [],
        startedAtMs: 0,
        endedAtMs: 1,
      }),
    ).toBe(true)
    await settleExporters()
    expect(exporters).toHaveLength(5)
    expect(await exporterExits.at(-1)).toEqual({ code: 0, signal: null })
  })
})
