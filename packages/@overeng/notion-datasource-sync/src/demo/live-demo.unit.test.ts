import { describe, expect, it } from 'vitest'

import {
  notionDatasourceSyncDemoManifest,
  notionDatasourceSyncFastDemoDataSources,
} from './live-demo.ts'

const compactId = (id: string) => id.replaceAll('-', '')

describe('notion datasource sync live demo manifest', () => {
  it('records the durable public demo page and database mapping', () => {
    expect(notionDatasourceSyncDemoManifest.pageId).toBe('36cf141b18dc803b98ebd21f2a243453')
    expect(notionDatasourceSyncDemoManifest.pageUrl).toContain(
      compactId(notionDatasourceSyncDemoManifest.pageId),
    )
    expect(
      notionDatasourceSyncDemoManifest.dataSources.map((dataSource) => dataSource.key),
    ).toEqual(['projects', 'incidents', 'customers', 'activity'])
    expect(
      new Set(notionDatasourceSyncDemoManifest.dataSources.map((dataSource) => dataSource.key))
        .size,
    ).toBe(4)
  })

  it('keeps database ids, URLs, row counts, and fast-replica scope explicit', () => {
    for (const dataSource of notionDatasourceSyncDemoManifest.dataSources) {
      expect(dataSource.databaseUrl).toContain(compactId(dataSource.databaseId))
      expect(dataSource.dataSourceId).toMatch(/^[0-9a-f-]{36}$/)
      expect(dataSource.expectedRows).toBeGreaterThan(0)
      expect(dataSource.expectedPropertyNames).toContain('Name')
    }

    expect(notionDatasourceSyncFastDemoDataSources.map((dataSource) => dataSource.key)).toEqual([
      'projects',
      'incidents',
      'customers',
    ])
    expect(
      notionDatasourceSyncDemoManifest.dataSources.find(
        (dataSource) => dataSource.key === 'activity',
      )?.fastReplica,
    ).toBe(false)
  })
})
