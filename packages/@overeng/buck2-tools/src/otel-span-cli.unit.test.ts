import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { afterEach, describe, expect, it } from 'vitest'

import { emitCompletedSpan, otelTraceContextActive, withOtelSpan } from './otel-span-cli.ts'

const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'

let activeDirectory: string | undefined

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
  activeDirectory = directory
  return {
    bin,
    captures: () =>
      readFileSync(capture, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0),
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
  afterEach(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    if (activeDirectory !== undefined) {
      rmSync(activeDirectory, { recursive: true, force: true })
      activeDirectory = undefined
    }
  })

  it('keeps every command unchanged without an active OTEL task trace context', () => {
    delete process.env.TRACEPARENT
    delete process.env.OTEL_TASK_TRACEPARENT
    delete process.env.OTEL_SPAN_SPOOL_DIR
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    delete process.env.OTELITE_HTTP_ENDPOINT
    expect(otelTraceContextActive()).toBe(false)
    const argv = ['/tools/buck2', 'build', '//:editor_view_inputs']
    expect(withOtelSpan({ name: 'buck2.build', label: 'buck2 build', attributes: [], argv })).toBe(
      argv,
    )
  })

  it('rejects malformed traceparents even when delivery is configured', () => {
    const directory = mkdtempSync(join(tmpdir(), 'otel-span-cli-'))
    process.env.OTEL_SPAN_SPOOL_DIR = directory
    process.env.TRACEPARENT = '00-not-a-traceparent'
    expect(otelTraceContextActive()).toBe(false)
  })

  it('wraps argv in an otel-span run command span when the context is active', () => {
    const fake = activateFakeOtelSpan()
    const wrapped = withOtelSpan({
      name: 'editor-view.publish',
      label: 'publish tui-core',
      attributes: [['package.path', 'packages/@overeng/tui-core']],
      argv: ['/tools/bun', '/tools/editor-view', 'publish'],
    })
    expect(wrapped).toEqual([
      fake.bin,
      'run',
      'effect-utils-devenv',
      'editor-view.publish',
      '--attr',
      'package.path=packages/@overeng/tui-core',
      '--attr',
      'span.label=publish tui-core',
      '--',
      '/tools/bun',
      '/tools/editor-view',
      'publish',
    ])
  })

  it('prefers OTEL_SPAN_BIN over the PATH lookup, like the task shell', () => {
    const fake = activateFakeOtelSpan()
    const declared = mkdtempSync(join(tmpdir(), 'otel-span-cli-'))
    activeDirectory = declared
    const declaredBin = join(declared, 'otel-span')
    writeFileSync(declaredBin, '#!/bin/sh\nexit 0\n')
    chmodSync(declaredBin, 0o755)
    process.env.OTEL_SPAN_BIN = declaredBin
    const wrapped = withOtelSpan({
      name: 'buck2.build',
      label: 'buck build',
      attributes: [],
      argv: ['/tools/buck2', 'build'],
    })
    expect(wrapped[0]).toBe(declaredBin)
    expect(fake.bin).not.toBe(declaredBin)
  })

  it('emits one completed span with typed phase attributes', () => {
    const fake = activateFakeOtelSpan()
    emitCompletedSpan({
      name: 'editor-view.phases',
      label: 'phases demo',
      attributes: [
        ['phase.fingerprint.ms', 101],
        ['snapshot.created', true],
        ['package.path', 'packages/@overeng/demo'],
      ],
      startedAtMs: 1_000,
      endedAtMs: 1_250,
    })
    const captured = fake.captures().join('\n')
    expect(captured).toContain('emit-span effect-utils-devenv editor-view.phases')
    expect(captured).toContain('--start-time-ns 1000000000')
    expect(captured).toContain('--end-time-ns 1250000000')
    expect(captured).toContain('--attr-int phase.fingerprint.ms=101')
    expect(captured).toContain('--attr-bool snapshot.created=true')
    expect(captured).toContain('--attr-string package.path=packages/@overeng/demo')
    expect(captured).toContain('--attr-string span.label=phases demo')
  })
})
