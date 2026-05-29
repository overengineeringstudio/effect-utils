import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Option, Schema, Tracer } from 'effect'
import { describe, expect, it } from 'vitest'

import { runCliCommand, serviceNameForCliCommand, type CliContext } from '../cli/main.ts'
import { AbsolutePath, WorkspaceRelativePath } from '../core/domain.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from '../core/ports.ts'
import { presentArtifactObservation } from '../local/workspace.ts'
import {
  otelServiceNameForCliArgv,
  otelServiceNames,
  spanAttr,
  spanNames,
} from '../observability/observability.ts'
import {
  defaultQueryContract,
  decode,
  fixedObservedAt,
  hash,
  makeFakeClock,
  makeFakeGatewayHarness,
  makeHarnessPorts,
  makeStoreFixture,
  testIds,
} from '../testing/harness.ts'

type RecordedSpan = {
  readonly name: string
  readonly spanId: string
  readonly traceId: string
  readonly parent: Option.Option<Tracer.AnySpan>
  readonly attributes: Record<string, unknown>
  ended: boolean
}

const makeRecordingTracer = (): {
  readonly tracer: Tracer.Tracer
  readonly spans: ReadonlyArray<RecordedSpan>
} => {
  const spans: RecordedSpan[] = []

  return {
    spans,
    tracer: Tracer.make({
      span: (name, parent, context, links, startTime, kind, options) => {
        const attributes = new Map<string, unknown>(Object.entries(options?.attributes ?? {}))
        const recorded: RecordedSpan = {
          name,
          spanId: `span-${spans.length + 1}`,
          traceId: 'trace-otel-e2e',
          parent,
          attributes: Object.fromEntries(attributes),
          ended: false,
        }
        spans.push(recorded)

        const span: Tracer.Span = {
          _tag: 'Span',
          name,
          spanId: recorded.spanId,
          traceId: recorded.traceId,
          parent,
          context,
          status: { _tag: 'Started', startTime },
          attributes,
          links,
          sampled: true,
          kind,
          end: () => {
            recorded.ended = true
          },
          attribute: (key, value) => {
            attributes.set(key, value)
            recorded.attributes[key] = value
          },
          event: () => {},
          addLinks: () => {},
        }
        return span
      },
      context: (f) => f(),
    }),
  }
}

const workspaceRoot = decode({ schema: AbsolutePath, value: '/tmp/notion-datasource-sync-otel' })

const context = (input: {
  readonly store: CliContext['store']
  readonly clock: ReturnType<typeof makeFakeClock>
}): CliContext => ({
  store: input.store,
  rootId: testIds.rootId,
  dataSourceId: testIds.dataSourceId,
  workspaceRoot,
  queryContract: defaultQueryContract(),
  schemaProperties: [],
  now: input.clock.now,
})

const spanParentName = (span: RecordedSpan): string | undefined =>
  Option.isSome(span.parent) === true && span.parent.value._tag === 'Span'
    ? span.parent.value.name
    : undefined

const spanAncestors = (span: RecordedSpan): ReadonlyArray<string> => {
  const ancestors: string[] = []
  let current = span.parent

  while (Option.isSome(current) === true && current.value._tag === 'Span') {
    ancestors.push(current.value.name)
    current = current.value.parent
  }

  return ancestors
}

const expectSpan = (
  spans: ReadonlyArray<RecordedSpan>,
  name: string,
  predicate: (span: RecordedSpan) => boolean = () => true,
): RecordedSpan => {
  const span = spans.find((candidate) => candidate.name === name && predicate(candidate))
  expect(
    span,
    `expected span ${name}; saw ${spans.map((candidate) => candidate.name).join(', ')}`,
  ).toBeDefined()
  return span!
}

const expectSpanAttributes = (span: RecordedSpan, attributes: Record<string, unknown>): void => {
  expect(span.attributes).toMatchObject(attributes)
}

describe('notion datasource sync OTEL tracing', () => {
  it('records a safe nested sync --watch trace with CLI, daemon, sync, gateway, and executor spans', async () => {
    expect(serviceNameForCliCommand({ _tag: 'sync' })).toBe(otelServiceNames.cli)
    expect(serviceNameForCliCommand({ _tag: 'sync', watch: true })).toBe(otelServiceNames.daemon)
    expect(otelServiceNameForCliArgv(['sync', '--watch'])).toBe(otelServiceNames.daemon)

    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness()
    const ports = makeHarnessPorts({
      localObservations: [
        presentArtifactObservation({
          pageId: testIds.pageId,
          path: decode({ schema: WorkspaceRelativePath, value: 'row--page-1.nmd' }),
          contentHash: hash('body-local-edit'),
          observedAt: decode({ schema: Schema.DateTimeUtc, value: fixedObservedAt }),
        }),
      ],
    })
    const trace = makeRecordingTracer()
    const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-otel-'))

    try {
      const result = await Effect.runPromise(
        runCliCommand(
          { _tag: 'sync', watch: true, statePath: join(dir, 'watch.json'), maxCycles: 1 },
          context({ store: storeFixture.store, clock }),
        ).pipe(
          Effect.provideService(NotionDataSourceGateway, gateway.gateway),
          Effect.provideService(PageBodySyncPort, ports.body),
          Effect.provideService(LocalWorkspacePort, ports.workspace),
          Effect.withTracer(trace.tracer),
        ),
      )

      expect(result.status.state).toBe('clean')

      const cli = expectSpan(trace.spans, spanNames.cliCommand)
      expect(spanParentName(cli)).toBeUndefined()
      expect(cli.attributes[spanAttr.processRole]).toBe('daemon')
      expect(cli.attributes[spanAttr.command]).toBe('sync')

      expectSpan(trace.spans, spanNames.daemonRun, (span) =>
        spanAncestors(span).includes(spanNames.cliCommand),
      )
      const daemonPass = expectSpan(trace.spans, spanNames.daemonPass, (span) =>
        spanAncestors(span).includes(spanNames.daemonRun),
      )
      expectSpanAttributes(daemonPass, {
        [spanAttr.cycle]: 1,
        [spanAttr.maxExecutorSteps]: 8,
        [spanAttr.processRole]: 'daemon',
        [spanAttr.result]: 'clean',
        [spanAttr.spanLabel]: 'cycle:1',
      })
      expectSpan(trace.spans, spanNames.syncOneShot, (span) =>
        spanAncestors(span).includes(spanNames.daemonPass),
      )
      expectSpan(trace.spans, spanNames.syncPull, (span) =>
        spanAncestors(span).includes(spanNames.syncOneShot),
      )
      const syncPush = expectSpan(trace.spans, spanNames.syncPush, (span) =>
        spanAncestors(span).includes(spanNames.syncOneShot),
      )
      expectSpanAttributes(syncPush, {
        [spanAttr.enqueuedCommands]: 1,
        [spanAttr.executorSteps]: 2,
        [spanAttr.maxStepsReached]: false,
        [spanAttr.outboxQueuedCount]: 0,
        [spanAttr.statusState]: 'clean',
      })
      expectSpan(trace.spans, spanNames.gatewayRequest, (span) =>
        spanAncestors(span).includes(spanNames.observationRemote),
      )
      expectSpan(trace.spans, spanNames.fakeGatewayRequest, (span) =>
        spanAncestors(span).includes(spanNames.gatewayRequest),
      )
      expectSpan(trace.spans, spanNames.outboxAttempt, (span) =>
        spanAncestors(span).includes(spanNames.syncPush),
      )
      expectSpan(trace.spans, spanNames.outboxObserveSurface, (span) =>
        spanAncestors(span).includes(spanNames.outboxAttempt),
      )
      expectSpan(trace.spans, spanNames.outboxWriteRemote, (span) =>
        spanAncestors(span).includes(spanNames.outboxAttempt),
      )

      for (const span of trace.spans.filter((candidate) => candidate.name.startsWith('notion.'))) {
        expect(span.ended, `${span.name} should be ended`).toBe(true)
        expect(span.attributes[spanAttr.spanLabel], `${span.name} span.label`).toEqual(
          expect.any(String),
        )
        expect(String(span.attributes[spanAttr.spanLabel]).length).toBeLessThanOrEqual(39)

        for (const [key, value] of Object.entries(span.attributes)) {
          expect(key).not.toMatch(/secret|token|workspace_root/i)
          expect(String(value)).not.toMatch(/secret|token|op:\/\//i)
          expect(String(value)).not.toContain(dir)
        }
      }
    } finally {
      storeFixture.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
