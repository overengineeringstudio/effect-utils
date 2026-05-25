import { Effect, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  makeNotionApiContract,
  makeNotionDataSourceGatewayLayer,
  type NotionDataSourceGatewayShape,
} from '../mod.ts'
import { makeFakeGatewayHarness, testIds } from '../testing/harness.ts'
import {
  emptyLiveFixtureLedger,
  defaultLivePreflightCapabilities,
  ledgerEntry,
  liveNotionConfigFromEnv,
  liveNotionEnvFromProcessEnv,
  runLiveFixtureLifecycle,
  runLiveNotionPreflight,
  strictLivePreflightCapabilities,
  type LiveFixtureLedger,
  type LiveFixtureLifecycleClient,
} from '../testing/live-notion.ts'
import { scenarioImplementationGaps, type ScenarioId } from '../testing/scenarios.ts'

const processLiveConfig = liveNotionConfigFromEnv(liveNotionEnvFromProcessEnv())
const implementedLiveScenarioIds = new Set<ScenarioId>(['NDS-LIVE-skeleton-gated-cleanup-ledger'])

describe('notion datasource sync live Notion E2E skeleton', () => {
  it('has a declared live scenario implementation', () => {
    expect(
      scenarioImplementationGaps({
        file: 'src/e2e/live-notion.e2e.test.ts',
        implementedScenarioIds: implementedLiveScenarioIds,
      }),
    ).toEqual([])
  })

  it('reports an explicit not-configured state when live Notion is not opted in', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_API_TOKEN: undefined,
        NOTION_TOKEN: undefined,
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: undefined,
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: undefined,
        NOTION_DATASOURCE_SYNC_LEDGER_PATH: undefined,
        NOTION_DATASOURCE_SYNC_LIVE: undefined,
      }),
    )

    expect(config._tag).toBe('not-configured')
    if (config._tag !== 'not-configured') return
    expect(config.skipReason).toContain('live Notion E2E disabled')
    expect(config.missing).toEqual(['NOTION_DATASOURCE_SYNC_LIVE=1'])
  })

  it('fails closed for partial opt-in live Notion configuration', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_DATASOURCE_SYNC_LIVE: '1',
        NOTION_API_TOKEN: 'ntn_realistic_token_shape',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: undefined,
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: '00000000000000000000000000000000',
      }),
    )

    expect(config).toMatchObject({
      _tag: 'invalid-config',
      missing: ['NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID'],
      invalid: [],
    })
  })

  it('does not opt in when dummy full live Notion env is present without the live flag', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_API_TOKEN: 'dummy-token',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: 'parent-page-id',
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: 'data-source-id',
        NOTION_DATASOURCE_SYNC_LEDGER_PATH: 'tmp/notion-datasource-sync-live/dummy.json',
        NOTION_DATASOURCE_SYNC_LIVE: undefined,
      }),
    )

    expect(config).toMatchObject({
      _tag: 'not-configured',
      missing: ['NOTION_DATASOURCE_SYNC_LIVE=1'],
    })
  })

  it('fails closed for opted-in dummy live Notion configuration', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_DATASOURCE_SYNC_LIVE: '1',
        NOTION_API_TOKEN: 'dummy-token',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: 'parent-page-id',
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: 'data-source-id',
      }),
    )

    expect(config).toMatchObject({
      _tag: 'invalid-config',
      missing: [],
      invalid: [
        'NOTION_API_TOKEN',
        'NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID',
        'NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID',
      ],
    })
    if (config._tag !== 'invalid-config') return
    expect(config.message).toContain('invalid configuration')
  })

  it('defaults live preflight to read-only capabilities', () => {
    const config = liveNotionConfigFromEnv(
      liveNotionEnvFromProcessEnv({
        NOTION_DATASOURCE_SYNC_LIVE: '1',
        NOTION_API_TOKEN: 'ntn_realistic_token_shape',
        NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID: '00000000000000000000000000000001',
        NOTION_DATASOURCE_SYNC_DATA_SOURCE_ID: '00000000000000000000000000000002',
      }),
    )

    expect(config).toMatchObject({
      _tag: 'configured',
      requiredCapabilities: [...defaultLivePreflightCapabilities],
    })
  })

  it('runs default live preflight read probes without requiring page-property pagination', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-default-read-preflight-test',
      parentPageId: testIds.pageId,
      dataSourceId: testIds.dataSourceId,
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/default-read-preflight-test.json',
    }
    const calls = {
      queryRows: 0,
      retrievePage: 0,
      retrievePageProperty: 0,
    }
    const ledgers: Array<LiveFixtureLedger> = []
    const harness = makeFakeGatewayHarness({ capabilities: defaultLivePreflightCapabilities })
    const gateway: NotionDataSourceGatewayShape = {
      ...harness.gateway,
      queryRows: (input) => {
        calls.queryRows += 1
        return harness.gateway.queryRows(input)
      },
      retrievePage: (input) => {
        calls.retrievePage += 1
        return harness.gateway.retrievePage(input)
      },
      retrievePageProperty: (input) => {
        calls.retrievePageProperty += 1
        return harness.gateway.retrievePageProperty(input)
      },
    }

    const result = await runLiveNotionPreflight(
      {
        enabled: true,
        token: 'ntn_realistic_token_shape',
        tokenSource: 'NOTION_API_TOKEN',
        parentPageId: configured.parentPageId,
        dataSourceId: configured.dataSourceId,
        requiredCapabilities: undefined,
        ledgerPath: configured.ledgerPath,
      },
      configured,
      {
        gatewayLayer: makeNotionDataSourceGatewayLayer(gateway),
        writeLedger: async ({ ledger }) => {
          ledgers.push(ledger)
        },
      },
    )

    expect(result.missingCapabilities).toEqual([])
    expect(calls).toEqual({ queryRows: 1, retrievePage: 1, retrievePageProperty: 0 })
    expect(ledgers.flatMap((ledger) => ledger.entries)).toEqual(
      expect.arrayContaining([expect.objectContaining({ cleanupState: 'verified-cleaned' })]),
    )
  })

  it('does not run live read probes or write verified-cleaned ledger entries when requested capabilities are missing', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-missing-capability-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: ['data_source_query', 'page_retrieve'] as const,
      ledgerPath: 'tmp/notion-datasource-sync-live/missing-capability-test.json',
    }
    const calls = {
      queryRows: 0,
      retrievePage: 0,
    }
    const ledgers: Array<LiveFixtureLedger> = []
    const apiContract = makeNotionApiContract({
      supportedCapabilities: ['data_source_query'],
    })
    const gateway: NotionDataSourceGatewayShape = {
      apiContract,
      preflightCapabilities: (input) =>
        Effect.succeed({
          _tag: 'CapabilityPreflightResult',
          dataSourceId: input.dataSourceId,
          apiContract,
          supportedCapabilities: input.requiredCapabilities.filter((capability) =>
            apiContract.supportedCapabilities.includes(capability),
          ),
          missingCapabilities: input.requiredCapabilities.filter(
            (capability) => apiContract.supportedCapabilities.includes(capability) === false,
          ),
        }),
      retrieveDataSource: () => Effect.die('retrieveDataSource should not be called'),
      queryRows: () => {
        calls.queryRows += 1
        return Stream.die('queryRows should not be called')
      },
      retrievePage: () => {
        calls.retrievePage += 1
        return Effect.die('retrievePage should not be called')
      },
      retrievePageProperty: () => Stream.die('retrievePageProperty should not be called'),
      patchPageProperties: () => Effect.die('patchPageProperties should not be called'),
      patchDataSourceSchema: () => Effect.die('patchDataSourceSchema should not be called'),
      trashPage: () => Effect.die('trashPage should not be called'),
      restorePage: () => Effect.die('restorePage should not be called'),
    }

    await expect(
      runLiveNotionPreflight(
        {
          enabled: true,
          token: 'ntn_realistic_token_shape',
          tokenSource: 'NOTION_API_TOKEN',
          parentPageId: configured.parentPageId,
          dataSourceId: configured.dataSourceId,
          requiredCapabilities: configured.requiredCapabilities.join(','),
          ledgerPath: configured.ledgerPath,
        },
        configured,
        {
          gatewayLayer: makeNotionDataSourceGatewayLayer(gateway),
          writeLedger: async ({ ledger }) => {
            ledgers.push(ledger)
          },
        },
      ),
    ).rejects.toThrow('Missing Notion capability: page_retrieve')

    expect(calls).toEqual({ queryRows: 0, retrievePage: 0 })
    expect(ledgers.flatMap((ledger) => ledger.entries)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ cleanupState: 'verified-cleaned' })]),
    )
  })

  it('fails closed before read probes when page-property pagination is required but unsupported', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-page-property-capability-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: strictLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/page-property-capability-test.json',
    }
    const calls = {
      queryRows: 0,
      retrievePage: 0,
      retrievePageProperty: 0,
    }
    const apiContract = makeNotionApiContract({
      supportedCapabilities: ['data_source_retrieve', 'data_source_query', 'page_retrieve'],
    })
    const gateway: NotionDataSourceGatewayShape = {
      apiContract,
      preflightCapabilities: (input) =>
        Effect.succeed({
          _tag: 'CapabilityPreflightResult',
          dataSourceId: input.dataSourceId,
          apiContract,
          supportedCapabilities: input.requiredCapabilities.filter((capability) =>
            apiContract.supportedCapabilities.includes(capability),
          ),
          missingCapabilities: input.requiredCapabilities.filter(
            (capability) => apiContract.supportedCapabilities.includes(capability) === false,
          ),
        }),
      retrieveDataSource: () => Effect.die('retrieveDataSource should not be called'),
      queryRows: () => {
        calls.queryRows += 1
        return Stream.die('queryRows should not be called')
      },
      retrievePage: () => {
        calls.retrievePage += 1
        return Effect.die('retrievePage should not be called')
      },
      retrievePageProperty: () => {
        calls.retrievePageProperty += 1
        return Stream.die('retrievePageProperty should not be called')
      },
      patchPageProperties: () => Effect.die('patchPageProperties should not be called'),
      patchDataSourceSchema: () => Effect.die('patchDataSourceSchema should not be called'),
      trashPage: () => Effect.die('trashPage should not be called'),
      restorePage: () => Effect.die('restorePage should not be called'),
    }

    await expect(
      runLiveNotionPreflight(
        {
          enabled: true,
          token: 'ntn_realistic_token_shape',
          tokenSource: 'NOTION_API_TOKEN',
          parentPageId: configured.parentPageId,
          dataSourceId: configured.dataSourceId,
          requiredCapabilities: configured.requiredCapabilities.join(','),
          ledgerPath: configured.ledgerPath,
        },
        configured,
        { gatewayLayer: makeNotionDataSourceGatewayLayer(gateway) },
      ),
    ).rejects.toThrow('Missing Notion capability: page_property_paginate')

    expect(calls).toEqual({ queryRows: 0, retrievePage: 0, retrievePageProperty: 0 })
  })

  it('runs a real preflight when live Notion is explicitly configured', async () => {
    if (processLiveConfig._tag === 'not-configured') {
      expect(processLiveConfig.skipReason).toContain('live Notion E2E disabled')
      return
    }
    if (processLiveConfig._tag === 'invalid-config') {
      expect(processLiveConfig.message).toContain('invalid configuration')
      return
    }

    if (processLiveConfig.requiredCapabilities.includes('page_property_paginate')) {
      await expect(
        runLiveNotionPreflight(liveNotionEnvFromProcessEnv(), processLiveConfig),
      ).rejects.toThrow('Missing Notion capability: page_property_paginate')
      return
    }

    const result = await runLiveNotionPreflight(liveNotionEnvFromProcessEnv(), processLiveConfig)
    expect(result.supportedCapabilities).toEqual(
      expect.arrayContaining([...processLiveConfig.requiredCapabilities]),
    )
    expect(result.missingCapabilities).toEqual([])
    expect(result.ledgerPath).toBe(processLiveConfig.ledgerPath)
  })

  it('records create, mutate, verify, trash, and restore fixture lifecycle phases with an injected client', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-fixture-lifecycle-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/fixture-lifecycle-test.json',
    }
    const calls: string[] = []
    const ledgers: LiveFixtureLedger[] = []
    const client: LiveFixtureLifecycleClient = {
      create: async () => {
        calls.push('create')
        return {
          objectId: 'fixture-page-1',
          objectType: 'page',
          purpose: 'fixture-lifecycle',
        }
      },
      mutate: async (fixture) => {
        calls.push('mutate')
        return fixture
      },
      verify: async () => {
        calls.push('verify')
      },
      trash: async () => {
        calls.push('trash')
      },
      restore: async () => {
        calls.push('restore')
      },
    }

    const ledger = await runLiveFixtureLifecycle(configured, client, {
      writeLedger: async ({ ledger: writtenLedger }) => {
        ledgers.push(writtenLedger)
      },
    })

    expect(calls).toEqual(['create', 'mutate', 'verify', 'trash', 'restore'])
    expect(ledger.entries.map((entry) => entry.phase)).toEqual([
      'create',
      'mutate',
      'verify',
      'trash',
      'restore',
    ])
    expect(ledgers.at(-1)).toEqual(ledger)
  })

  it('cleans up the injected live fixture and records the ledger when verification fails', async () => {
    const configured = {
      _tag: 'configured' as const,
      runId: 'notion-ds-sync-fixture-failure-cleanup-test',
      parentPageId: '00000000000000000000000000000001',
      dataSourceId: '00000000000000000000000000000002',
      notionVersion: '2026-03-11' as const,
      requiredCapabilities: defaultLivePreflightCapabilities,
      ledgerPath: 'tmp/notion-datasource-sync-live/fixture-failure-cleanup-test.json',
    }
    const calls: string[] = []
    const ledgers: LiveFixtureLedger[] = []
    const client: LiveFixtureLifecycleClient = {
      create: async () => {
        calls.push('create')
        return {
          objectId: 'fixture-page-1',
          objectType: 'page',
          purpose: 'fixture-failure-cleanup',
        }
      },
      mutate: async (fixture) => {
        calls.push('mutate')
        return fixture
      },
      verify: async () => {
        calls.push('verify')
        throw new Error('forced fixture verification failure')
      },
      trash: async () => {
        calls.push('trash')
      },
      restore: async () => {
        calls.push('restore')
      },
    }

    await expect(
      runLiveFixtureLifecycle(configured, client, {
        writeLedger: async ({ ledger: writtenLedger }) => {
          ledgers.push(writtenLedger)
        },
      }),
    ).rejects.toThrow('forced fixture verification failure')

    expect(calls).toEqual(['create', 'mutate', 'verify', 'trash', 'restore'])
    expect(ledgers.at(-1)?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'trash', cleanupState: 'trashed' }),
        expect.objectContaining({ phase: 'restore', cleanupState: 'restored' }),
      ]),
    )
  })

  it('defines a sanitized cleanup ledger shape without exposing secrets', () => {
    const configured =
      processLiveConfig._tag === 'configured'
        ? processLiveConfig
        : {
            _tag: 'configured' as const,
            runId: 'notion-ds-sync-test-run',
            parentPageId: 'parent-page-id',
            dataSourceId: 'data-source-id',
            notionVersion: '2026-03-11' as const,
            requiredCapabilities: [
              'data_source_retrieve',
              'data_source_query',
              'page_retrieve',
            ] as const,
            ledgerPath: 'tmp/notion-datasource-sync-live/notion-ds-sync-test-run.json',
          }
    const ledger = {
      ...emptyLiveFixtureLedger(configured),
      entries: [
        ledgerEntry({
          phase: 'create',
          objectId: 'page-id-1',
          objectType: 'page',
          purpose: 'capability-preflight-fixture',
        }),
      ],
    }

    expect(ledger).toEqual({
      runId: configured.runId,
      notionVersion: '2026-03-11',
      entries: [
        {
          phase: 'create',
          objectId: 'page-id-1',
          objectType: 'page',
          purpose: 'capability-preflight-fixture',
          cleanupState: 'created',
        },
      ],
    })
    expect(JSON.stringify(ledger)).not.toContain('NOTION_TOKEN')
  })
})
