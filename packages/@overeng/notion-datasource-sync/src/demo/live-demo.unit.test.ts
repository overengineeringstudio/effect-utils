import { describe, expect, it } from 'vitest'

import {
  assertNotionDatasourceSyncDemoManifestContract,
  formatNotionDatasourceSyncDemoAccessFailure,
  notionDatasourceSyncDemoManifest,
  notionDatasourceSyncFastDemoDataSources,
  resolveNotionDatasourceSyncDemoDataSources,
} from './live-demo.ts'

const compactId = (id: string) => id.replaceAll('-', '')

describe('notion datasource sync live demo manifest', () => {
  it('records the durable public demo page and database mapping', () => {
    expect(notionDatasourceSyncDemoManifest).toMatchObject({
      apiVersion: 1,
      fixtureKind: 'public-synthetic',
      readOnlyContract: {
        lane: 'read-only-verifier',
        minDurableRows: 500,
        localFullReplica: 'explicit-opt-in',
      },
      provisionerContract: {
        lane: 'provisioner',
        writes: 'public-synthetic-fixtures-only',
        emittedIds: 'env-or-public-synthetic-manifest',
      },
    })
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

  it('validates the explicit read-only and provisioner manifest lanes without credentials', () => {
    expect(
      assertNotionDatasourceSyncDemoManifestContract({
        value: notionDatasourceSyncDemoManifest,
        lane: 'read-only-verifier',
      }).dataSources.find((dataSource) => dataSource.key === 'activity'),
    ).toMatchObject({ expectedRows: 500, fastReplica: false })

    expect(
      assertNotionDatasourceSyncDemoManifestContract({
        value: notionDatasourceSyncDemoManifest,
        lane: 'provisioner',
      }).provisionerContract,
    ).toMatchObject({
      ownedBy: 'notion-datasource-sync-demo-provisioner',
      writes: 'public-synthetic-fixtures-only',
    })
  })

  it('fails closed when the durable 500+ row fixture is missing or placed in the fast lane', () => {
    expect(() =>
      assertNotionDatasourceSyncDemoManifestContract({
        value: {
          ...notionDatasourceSyncDemoManifest,
          dataSources: notionDatasourceSyncDemoManifest.dataSources.map((dataSource) =>
            dataSource.key === 'activity' ? { ...dataSource, expectedRows: 499 } : dataSource,
          ),
        },
        lane: 'read-only-verifier',
      }),
    ).toThrow('at least 500 rows')

    expect(() =>
      assertNotionDatasourceSyncDemoManifestContract({
        value: {
          ...notionDatasourceSyncDemoManifest,
          dataSources: notionDatasourceSyncDemoManifest.dataSources.map((dataSource) =>
            dataSource.key === 'activity' ? { ...dataSource, fastReplica: true } : dataSource,
          ),
        },
        lane: 'read-only-verifier',
      }),
    ).toThrow('fast replica lane')
  })

  it('fails closed when the provisioner lane is not scoped to public synthetic fixtures', () => {
    expect(() =>
      assertNotionDatasourceSyncDemoManifestContract({
        value: {
          ...notionDatasourceSyncDemoManifest,
          fixtureKind: 'private-workspace',
        },
        lane: 'provisioner',
      }),
    ).toThrow()

    expect(() =>
      assertNotionDatasourceSyncDemoManifestContract({
        value: {
          ...notionDatasourceSyncDemoManifest,
          provisionerContract: {
            ...notionDatasourceSyncDemoManifest.provisionerContract,
            writes: 'any-workspace',
          },
        },
        lane: 'provisioner',
      }),
    ).toThrow()
  })

  it('resolves provisioned live data-source IDs by stable synthetic database title', () => {
    const resolved = resolveNotionDatasourceSyncDemoDataSources({
      manifest: notionDatasourceSyncDemoManifest,
      childDatabases: notionDatasourceSyncDemoManifest.dataSources.map((dataSource, index) => ({
        title: dataSource.title,
        databaseId: `00000000-0000-0000-0000-00000000000${index.toString()}`,
        dataSourceId: `10000000-0000-0000-0000-00000000000${index.toString()}`,
      })),
    })

    expect(resolved.map((dataSource) => dataSource.key)).toEqual([
      'projects',
      'incidents',
      'customers',
      'activity',
    ])
    expect(resolved[0]).toMatchObject({
      key: 'projects',
      databaseId: '00000000-0000-0000-0000-000000000000',
      databaseUrl: 'https://www.notion.so/00000000000000000000000000000000',
      dataSourceId: '10000000-0000-0000-0000-000000000000',
    })
    expect(resolved[3]).toMatchObject({ expectedRows: 500, fastReplica: false })
  })

  it('fails closed when title-based provisioned live data-source resolution is ambiguous', () => {
    const [first] = notionDatasourceSyncDemoManifest.dataSources
    if (first === undefined) throw new Error('expected demo manifest source')

    expect(() =>
      resolveNotionDatasourceSyncDemoDataSources({
        manifest: notionDatasourceSyncDemoManifest,
        childDatabases: [],
      }),
    ).toThrow('missing child database projects')

    expect(() =>
      resolveNotionDatasourceSyncDemoDataSources({
        manifest: notionDatasourceSyncDemoManifest,
        childDatabases: [
          {
            title: first.title,
            databaseId: '00000000-0000-0000-0000-000000000001',
            dataSourceId: '10000000-0000-0000-0000-000000000001',
          },
          {
            title: first.title,
            databaseId: '00000000-0000-0000-0000-000000000002',
            dataSourceId: '10000000-0000-0000-0000-000000000002',
          },
        ],
      }),
    ).toThrow('duplicate child database projects')
  })

  it('formats Notion access failures as sanitized actionable blockers', () => {
    const rawBody = JSON.stringify({
      object: 'error',
      status: 404,
      code: 'object_not_found',
      message:
        'Could not find block with ID: 00000000-0000-0000-0000-000000000001. Make sure the relevant pages and databases are shared with your integration "demo-integration".',
      additional_data: {
        integration_id: '00000000-0000-0000-0000-000000000002',
      },
      request_id: '00000000-0000-0000-0000-000000000003',
    })

    const message = formatNotionDatasourceSyncDemoAccessFailure({
      operation: 'list-demo-page-databases',
      targetAlias: 'demo-page',
      status: 404,
      body: rawBody,
    })

    expect(message).toContain('operation=list-demo-page-databases target=demo-page')
    expect(message).toContain('status=404 code=object_not_found')
    expect(message).toContain('share the durable synthetic demo page')
    expect(message).not.toContain('00000000-0000-0000-0000-000000000001')
    expect(message).not.toContain('00000000-0000-0000-0000-000000000002')
    expect(message).not.toContain('00000000-0000-0000-0000-000000000003')
    expect(message).not.toContain('demo-integration')
  })

  it('formats CLI-level demo sync failures without raw Notion IDs', () => {
    const message = formatNotionDatasourceSyncDemoAccessFailure({
      operation: 'sync-data-source',
      targetAlias: 'data-source:activity',
      code: 'cli_argument_error',
    })

    expect(message).toContain('operation=sync-data-source target=data-source:activity')
    expect(message).toContain('status=unavailable code=cli_argument_error')
    expect(message).toContain('verify the configured Notion integration can read')
  })
})
