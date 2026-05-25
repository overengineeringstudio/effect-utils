import { describe, expect, it } from 'vitest'

import {
  emptyLiveFixtureLedger,
  ledgerEntry,
  liveNotionConfigFromEnv,
  liveNotionEnvFromProcessEnv,
  runLiveNotionPreflight,
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

  it('runs a real preflight when live Notion is explicitly configured', async () => {
    if (processLiveConfig._tag === 'not-configured') {
      expect(processLiveConfig.skipReason).toContain('live Notion E2E disabled')
      return
    }
    if (processLiveConfig._tag === 'invalid-config') {
      expect(processLiveConfig.message).toContain('invalid configuration')
      return
    }

    const result = await runLiveNotionPreflight(liveNotionEnvFromProcessEnv(), processLiveConfig)
    expect(result.supportedCapabilities).toEqual(
      expect.arrayContaining([...processLiveConfig.requiredCapabilities]),
    )
    expect(result.missingCapabilities).toEqual([])
    expect(result.ledgerPath).toBe(processLiveConfig.ledgerPath)
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
