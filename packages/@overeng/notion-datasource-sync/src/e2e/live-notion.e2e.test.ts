import { describe, expect, it } from 'vitest'

import {
  emptyLiveFixtureLedger,
  ledgerEntry,
  liveNotionConfigFromEnv,
  liveNotionEnvFromProcessEnv,
} from '../testing/live-notion.ts'

const config = liveNotionConfigFromEnv(liveNotionEnvFromProcessEnv())

describe('notion datasource sync live Notion E2E skeleton', () => {
  it('skips with an explicit reason when live Notion is not configured', () => {
    if (config._tag === 'configured') {
      expect(config.notionVersion).toBe('2026-03-11')
      return
    }

    expect(config.skipReason).toContain('live Notion E2E disabled')
    expect(config.missing.length).toBeGreaterThan(0)
  })

  it('defines a sanitized cleanup ledger shape without exposing secrets', () => {
    const configured =
      config._tag === 'configured'
        ? config
        : {
            _tag: 'configured' as const,
            runId: 'notion-ds-sync-test-run',
            parentPageId: 'parent-page-id',
            notionVersion: '2026-03-11' as const,
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
