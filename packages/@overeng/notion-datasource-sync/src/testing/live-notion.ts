import { randomUUID } from 'node:crypto'

export type LiveNotionEnv = {
  readonly enabled: boolean
  readonly token: string | undefined
  readonly parentPageId: string | undefined
  readonly ledgerPath: string | undefined
}

export type LiveNotionConfig =
  | {
      readonly _tag: 'not-configured'
      readonly skipReason: string
      readonly missing: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'configured'
      readonly runId: string
      readonly parentPageId: string
      readonly notionVersion: '2026-03-11'
      readonly ledgerPath: string
    }

export type LiveFixtureLedgerEntry = {
  readonly objectId: string
  readonly objectType: 'page' | 'data_source' | 'database' | 'block' | 'file'
  readonly purpose: string
  readonly cleanupState: 'created' | 'trashed' | 'verified-cleaned' | 'cleanup-failed'
}

export type LiveFixtureLedger = {
  readonly runId: string
  readonly notionVersion: '2026-03-11'
  readonly entries: ReadonlyArray<LiveFixtureLedgerEntry>
}

export const liveNotionEnvFromProcessEnv = (
  env: NodeJS.ProcessEnv = process.env,
): LiveNotionEnv => ({
  enabled: env.NOTION_DATASOURCE_SYNC_LIVE === '1',
  token: env.NOTION_TOKEN,
  parentPageId: env.NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID,
  ledgerPath: env.NOTION_DATASOURCE_SYNC_LEDGER_PATH,
})

export const liveNotionConfigFromEnv = (env: LiveNotionEnv): LiveNotionConfig => {
  const parentPageId = env.parentPageId
  const token = env.token
  const missing = [
    ...(env.enabled ? [] : ['NOTION_DATASOURCE_SYNC_LIVE=1']),
    ...(token === undefined ? ['NOTION_TOKEN'] : []),
    ...(parentPageId === undefined ? ['NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID'] : []),
  ]

  if (missing.length > 0 || token === undefined || parentPageId === undefined) {
    return {
      _tag: 'not-configured',
      skipReason: `live Notion E2E disabled; missing ${missing.join(', ')}`,
      missing,
    }
  }

  return {
    _tag: 'configured',
    runId: `notion-ds-sync-${randomUUID()}`,
    parentPageId,
    notionVersion: '2026-03-11',
    ledgerPath: env.ledgerPath ?? `tmp/notion-datasource-sync-live/${randomUUID()}.json`,
  }
}

export const emptyLiveFixtureLedger = (config: Extract<LiveNotionConfig, { _tag: 'configured' }>) =>
  ({
    runId: config.runId,
    notionVersion: config.notionVersion,
    entries: [],
  }) satisfies LiveFixtureLedger

export const ledgerEntry = (
  input: Omit<LiveFixtureLedgerEntry, 'cleanupState'> & {
    readonly cleanupState?: LiveFixtureLedgerEntry['cleanupState']
  },
): LiveFixtureLedgerEntry => ({
  cleanupState: 'created',
  ...input,
})
