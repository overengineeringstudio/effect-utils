import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { testIds } from '../testing/harness.ts'
import {
  correlationSpanAttrs,
  notionDatasourceSpanAttributes,
  otelCorrelationSpanAttributes,
  otelServiceNameForCliArgv,
  otelServiceNames,
  spanAttr,
  spanAttributes,
  spanContracts,
  spanLabel,
  spanNames,
  statusSpanAttrs,
  statusSpanAttributes,
} from './observability.ts'

const source = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')

const instrumentedSources = [
  'cli/main.ts',
  'daemon/watch.ts',
  'sync/executor.ts',
  'gateway/gateway.ts',
  'gateway/fake.ts',
  'sync/observation.ts',
  'sync/sync.ts',
].map((name) => [name, source(name)] as const)

describe('notion datasource sync observability', () => {
  it('keeps process service names role-specific', () => {
    expect(otelServiceNames).toEqual({
      cli: 'notion-datasource-sync-cli',
      daemon: 'notion-datasource-sync-daemon',
    })
    expect(otelServiceNameForCliArgv(['sync', '--watch'])).toBe('notion-datasource-sync-daemon')
    expect(otelServiceNameForCliArgv(['sync'])).toBe('notion-datasource-sync-cli')
  })

  it('keeps the span catalog queryable and stable', () => {
    expect(spanNames).toMatchInlineSnapshot(`
      {
        "cliCommand": "notion.datasource.cli",
        "daemonPass": "notion.datasource.daemon.pass",
        "daemonRun": "notion.datasource.daemon.run",
        "fakeGatewayRequest": "notion.datasource.fake-gateway.request",
        "gatewayRequest": "notion.api.request",
        "observationLocal": "notion.datasource.observation.local",
        "observationRemote": "notion.datasource.observation.remote",
        "outboxAttempt": "notion.datasource.outbox.attempt",
        "outboxObserveSurface": "notion.datasource.outbox.observe-surface",
        "outboxWriteRemote": "notion.datasource.outbox.write-remote",
        "syncEstablishFromNotion": "notion.datasource.sync.establish-from-notion",
        "syncInit": "notion.datasource.sync.init",
        "syncOneShot": "notion.datasource.sync.one-shot",
        "syncPull": "notion.datasource.sync.pull",
        "syncPush": "notion.datasource.sync.push",
        "syncQueryAbsence": "notion.datasource.sync.query-absence",
      }
    `)
  })

  it('keeps generated span labels concise', () => {
    expect(spanLabel('patchPageProperties', '1234567890abcdef')).toBe(
      'patchPageProperties:1234567890abcdef',
    )
    expect(spanLabel('retrievePageProperty', 'page-1234567890abcdef', 'prop')).toHaveLength(39)
  })

  it('backs the package attribute helper with the schema-first OTEL contract', () => {
    expect(notionDatasourceSpanAttributes.keys.has(spanAttr.spanLabel)).toBe(true)
    expect(notionDatasourceSpanAttributes.keys.has(spanAttr.processRole)).toBe(true)
    expect(notionDatasourceSpanAttributes.keys.has(spanAttr.statusState)).toBe(true)
    expect(notionDatasourceSpanAttributes.hasSpanLabel).toBe(true)

    expect(
      spanAttributes({
        [spanAttr.spanLabel]: 'sync:root-1',
        [spanAttr.processRole]: 'library',
        [spanAttr.operation]: 'sync',
        [spanAttr.rootId]: undefined,
        [spanAttr.rowCount]: 3,
      }),
    ).toEqual({
      [spanAttr.spanLabel]: 'sync:root-1',
      [spanAttr.processRole]: 'library',
      [spanAttr.operation]: 'sync',
      [spanAttr.rowCount]: 3,
    })
  })

  it('keeps every span name coupled to a schema-backed span contract', () => {
    expect(Object.keys(spanContracts)).toEqual(Object.keys(spanNames))
    expect(
      Object.fromEntries(
        Object.entries(spanContracts).map(([key, contract]) => [key, contract.name]),
      ),
    ).toEqual(spanNames)

    for (const contract of Object.values(spanContracts)) {
      expect(contract.attributes.hasSpanLabel).toBe(true)
    }
  })

  it('uses focused schemas for status and correlation attributes', () => {
    expect(statusSpanAttrs.keys.has(spanAttr.statusState)).toBe(true)
    expect(correlationSpanAttrs.keys.has(spanAttr.agentIterationId)).toBe(true)

    expect(
      statusSpanAttributes({
        rootId: testIds.rootId,
        binding: undefined,
        state: 'blocked',
        counts: {
          clean: 0,
          pending: 0,
          conflict: 1,
          blocked: 2,
          outbox: {
            ambiguous: 3,
            blocked: 4,
            queued: 5,
            retryable: 6,
            running: 7,
            fenced: 8,
            settled: 9,
          },
          projections: { dataSources: 0, rows: 0, properties: 0, bodies: 0 },
          tombstones: { unclassified: 0 },
          guards: { blocked: 0 },
          capabilities: { unsupported: 0 },
          checkpoints: {
            incompleteQueries: 0,
            cappedQueries: 0,
            changedQueryContracts: 0,
            incompleteProperties: 0,
          },
        },
      }),
    ).toMatchObject({
      [spanAttr.statusState]: 'blocked',
      [spanAttr.blockedCount]: 2,
      [spanAttr.conflictCount]: 1,
      [spanAttr.outboxAmbiguousCount]: 3,
      [spanAttr.outboxBlockedCount]: 4,
      [spanAttr.outboxQueuedCount]: 5,
      [spanAttr.outboxRetryableCount]: 6,
      [spanAttr.outboxRunningCount]: 7,
    })
  })

  it('keeps otel run correlation queryable on the command span', () => {
    expect(
      otelCorrelationSpanAttributes({
        agentRunId: 'agent-run-direct',
        resourceAttributes: 'agent.iteration.id=agent-run-resource',
      }),
    ).toEqual({ [spanAttr.agentIterationId]: 'agent-run-direct' })
    expect(
      otelCorrelationSpanAttributes({
        resourceAttributes: 'deployment.environment=test,agent.iteration.id=agent-run-resource',
      }),
    ).toEqual({ [spanAttr.agentIterationId]: 'agent-run-resource' })
  })

  it('uses the shared span catalog for all touched Effect spans', () => {
    const directStringSpans = instrumentedSources.flatMap(([name, text]) =>
      [...text.matchAll(/(?:Effect|Stream)\.(?:fn|withSpan)\(\s*['"]/g)].map(
        (match) => `${name}:${match[0]}`,
      ),
    )
    expect(directStringSpans).toEqual([])
  })

  it('keeps CLI, one-shot, and daemon spans wired through the shared catalog', () => {
    expect(source('cli/main.ts')).toContain('Effect.fn(spanNames.cliCommand, {')
    expect(source('cli/main.ts')).toContain(
      'makeOtelCliLayer({ serviceName: serviceNameForArgv(argv) })',
    )
    expect(source('sync/sync.ts')).toContain('Effect.fn(spanNames.syncPull)')
    expect(source('sync/sync.ts')).toContain('Effect.fn(spanNames.syncPush)')
    expect(source('sync/sync.ts')).toContain('Effect.fn(spanNames.syncOneShot)')
    expect(source('daemon/watch.ts')).toContain('Effect.fn(spanNames.daemonPass, {')
    expect(source('daemon/watch.ts')).toContain('Effect.fn(spanNames.daemonRun, {')
  })
})
