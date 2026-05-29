import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  otelCorrelationSpanAttributes,
  otelServiceNameForCliArgv,
  otelServiceNames,
  spanAttr,
  spanLabel,
  spanNames,
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
      }
    `)
  })

  it('keeps generated span labels concise', () => {
    expect(spanLabel('patchPageProperties', '1234567890abcdef')).toBe(
      'patchPageProperties:1234567890abcdef',
    )
    expect(spanLabel('retrievePageProperty', 'page-1234567890abcdef', 'prop')).toHaveLength(39)
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
