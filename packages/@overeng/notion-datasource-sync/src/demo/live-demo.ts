/** Stable keys for the durable Notion datasource-sync demo domains. */
export type NotionDatasourceSyncDemoDataSourceKey =
  | 'projects'
  | 'incidents'
  | 'customers'
  | 'activity'

/** Expected live Notion database/data-source shape for one demo domain. */
export type NotionDatasourceSyncDemoDataSource = {
  readonly key: NotionDatasourceSyncDemoDataSourceKey
  readonly title: string
  readonly databaseId: string
  readonly databaseUrl: string
  readonly dataSourceId: string
  readonly expectedRows: number
  readonly expectedPropertyNames: readonly string[]
  readonly fastReplica: boolean
}

/** Durable online demo page plus every child data source the package verifies. */
export type NotionDatasourceSyncDemoManifest = {
  readonly pageId: string
  readonly pageUrl: string
  readonly dataSources: readonly NotionDatasourceSyncDemoDataSource[]
}

/** Source-of-truth manifest for the public automated datasource-sync demo page. */
export const notionDatasourceSyncDemoManifest = {
  pageId: '36cf141b18dc803b98ebd21f2a243453',
  pageUrl:
    'https://www.notion.so/overeng-notion-datasource-sync-demo-automated-36cf141b18dc803b98ebd21f2a243453',
  dataSources: [
    {
      key: 'projects',
      title: 'notion datasource sync demo projects',
      databaseId: 'dcd16fba-737e-4c30-b5d0-e16c60e76537',
      databaseUrl: 'https://www.notion.so/dcd16fba737e4c30b5d0e16c60e76537',
      dataSourceId: '3a936610-2e39-436a-98b3-438caca366b5',
      expectedRows: 12,
      expectedPropertyNames: [
        'Name',
        'State',
        'Budget',
        'Strategic',
        'Kickoff',
        'Teams',
        'Summary',
        'Brief',
      ],
      fastReplica: true,
    },
    {
      key: 'incidents',
      title: 'notion datasource sync demo incidents',
      databaseId: '52c6cfd2-48e5-4298-9498-689e972ed89f',
      databaseUrl: 'https://www.notion.so/52c6cfd248e542989498689e972ed89f',
      dataSourceId: '3d4e761b-4e03-4c3e-967e-1ef2ed698d6a',
      expectedRows: 30,
      expectedPropertyNames: ['Name', 'Severity', 'Open', 'Started', 'Impact', 'Systems', 'Notes'],
      fastReplica: true,
    },
    {
      key: 'customers',
      title: 'notion datasource sync demo customers',
      databaseId: '74172538-64bd-41d0-8377-9d9a1c3c2118',
      databaseUrl: 'https://www.notion.so/7417253864bd41d083779d9a1c3c2118',
      dataSourceId: '6b0e86c4-df36-42fd-9f63-4a694c271542',
      expectedRows: 48,
      expectedPropertyNames: [
        'Name',
        'Plan',
        'ARR',
        'Renewal',
        'Contacted',
        'Regions',
        'Health',
        'Email',
        'Phone',
      ],
      fastReplica: true,
    },
    {
      key: 'activity',
      title: 'notion datasource sync demo activity events',
      databaseId: '348fc8eb-40e3-46e6-a0b5-0eeda00ba4c4',
      databaseUrl: 'https://www.notion.so/348fc8eb40e346e6a0b50eeda00ba4c4',
      dataSourceId: '5fbd8d54-7ea2-46ca-a8b5-784a1bb147c3',
      expectedRows: 500,
      expectedPropertyNames: [
        'Name',
        'Segment',
        'Sequence',
        'Automated',
        'EventDate',
        'Labels',
        'Payload',
      ],
      fastReplica: false,
    },
  ],
} as const satisfies NotionDatasourceSyncDemoManifest

/** Demo data sources small enough for the default live local-replica verifier. */
export const notionDatasourceSyncFastDemoDataSources =
  notionDatasourceSyncDemoManifest.dataSources.filter((dataSource) => dataSource.fastReplica)

/** All demo data sources, including the opt-in high-cardinality activity replica. */
export const notionDatasourceSyncFullDemoDataSources = notionDatasourceSyncDemoManifest.dataSources
