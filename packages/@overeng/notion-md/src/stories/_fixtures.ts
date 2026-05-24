import { Schema } from 'effect'

export const Severity = Schema.Literal('critical', 'warning')
export type Severity = 'critical' | 'warning'

export const CommandFixtureId = Schema.Literal(
  'clean-status',
  'body-conflict',
  'unknown-blocks',
  'watch-sync',
  'missing-token',
)
export type CommandFixtureId =
  | 'clean-status'
  | 'body-conflict'
  | 'unknown-blocks'
  | 'watch-sync'
  | 'missing-token'

export const ProblemFixture = Schema.Struct({
  severity: Severity,
  name: Schema.String,
  status: Schema.String,
  details: Schema.String,
  context: Schema.optional(Schema.String),
  fixes: Schema.Array(Schema.String),
  skips: Schema.optional(Schema.Array(Schema.String)),
})
export type ProblemFixture = typeof ProblemFixture.Type

export const DetailSectionFixture = Schema.Struct({
  title: Schema.String,
  items: Schema.Array(Schema.String),
  more: Schema.optional(Schema.Number),
})
export type DetailSectionFixture = typeof DetailSectionFixture.Type

export const MainItemFixture = Schema.Struct({
  name: Schema.String,
  ref: Schema.String,
  status: Schema.optional(Schema.Literal('error', 'modified', 'ok', 'synced')),
  relationship: Schema.optional(Schema.String),
  sections: Schema.Array(DetailSectionFixture),
})
export type MainItemFixture = typeof MainItemFixture.Type

export const CommandFixture = Schema.Struct({
  id: CommandFixtureId,
  command: Schema.String,
  context: Schema.String,
  problems: Schema.Array(ProblemFixture),
  items: Schema.Array(MainItemFixture),
  summary: Schema.String,
})
export type CommandFixture = typeof CommandFixture.Type

export const CommandFixtureAction = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal('SetFixture'),
    fixture: CommandFixture,
  }),
)
export type CommandFixtureAction = typeof CommandFixtureAction.Type

export const commandFixtureIds: readonly CommandFixtureId[] = [
  'clean-status',
  'body-conflict',
  'unknown-blocks',
  'watch-sync',
  'missing-token',
]

const demoPage = '368f141b18dc80e4850cff344ad5b48e'

export const createCleanStatusFixture = (): CommandFixture => ({
  id: 'clean-status',
  command: 'notion-md status demo/showcase.nmd',
  context: 'notion-md status · demo/showcase.nmd',
  problems: [],
  items: [
    {
      name: 'demo/showcase.nmd',
      ref: `notion@${demoPage.slice(0, 8)}`,
      status: 'synced',
      relationship: 'local = remote',
      sections: [
        {
          title: 'state',
          items: ['body clean', 'frontmatter clean', 'properties clean', 'unknown blocks 0'],
        },
        {
          title: 'objects',
          items: ['base snapshot verified', 'metadata refs verified'],
        },
      ],
    },
  ],
  summary: '1 file · 0 local edits · 0 remote edits · 0 unresolved blocks',
})

export const createBodyConflictFixture = (): CommandFixture => ({
  id: 'body-conflict',
  command: 'notion-md sync notes/planning.nmd',
  context: 'notion-md sync · notes/planning.nmd',
  problems: [
    {
      severity: 'critical',
      name: 'notes/planning.nmd',
      status: 'blocked',
      details: 'remote body changed since the last clean pull',
      context: 'conflict artifact: notes/planning.nmd.roughdraft.md',
      fixes: [
        'notion-md status notes/planning.nmd',
        'edit notes/planning.nmd.roughdraft.md, then apply the chosen body to notes/planning.nmd',
        'notion-md sync notes/planning.nmd',
      ],
      skips: ['notion-md sync notes/planning.nmd --force'],
    },
  ],
  items: [
    {
      name: 'notes/planning.nmd',
      ref: 'notion@9a7c1e04',
      status: 'error',
      relationship: 'local ↕ remote',
      sections: [
        {
          title: 'changes',
          items: ['local body edited', 'remote body edited', 'frontmatter unchanged'],
        },
        {
          title: 'merge',
          items: ['automatic merge refused', 'roughdraft conflict file written'],
        },
      ],
    },
  ],
  summary: '1 file · 1 blocking conflict · 0 pushed',
})

export const createUnknownBlocksFixture = (): CommandFixture => ({
  id: 'unknown-blocks',
  command: 'notion-md sync docs/research.nmd',
  context: 'notion-md sync · docs/research.nmd',
  problems: [
    {
      severity: 'warning',
      name: 'docs/research.nmd',
      status: 'guarded',
      details: 'page contains unsupported Notion blocks that replace_content could delete',
      context: 'unsupported blocks are preserved in .notion-md object refs',
      fixes: ['pull latest page state', 'remove local body edits or model the unsupported blocks'],
      skips: ['notion-md sync docs/research.nmd --allow-delete-unknown-blocks'],
    },
  ],
  items: [
    {
      name: 'docs/research.nmd',
      ref: 'notion@4f0b9d11',
      status: 'modified',
      relationship: 'local body edited',
      sections: [
        {
          title: 'unknown-blocks',
          items: ['synced_block 1', 'equation 1', 'link_preview 2', 'pdf 1', 'bookmark 1'],
          more: 3,
        },
        {
          title: 'policy',
          items: ['non-destructive write refused until intent is explicit'],
        },
      ],
    },
  ],
  summary: '1 file · 1 guarded edit · 8 unsupported blocks',
})

export const createWatchSyncFixture = (): CommandFixture => ({
  id: 'watch-sync',
  command: 'notion-md sync demo/showcase.nmd --watch --poll-interval-ms 30000',
  context: 'notion-md sync --watch · demo/showcase.nmd',
  problems: [],
  items: [
    {
      name: 'demo/showcase.nmd',
      ref: `notion@${demoPage.slice(0, 8)}`,
      status: 'ok',
      relationship: 'watching',
      sections: [
        {
          title: 'events',
          items: [
            '{"event":"sync","reason":"initial","result":{"_tag":"noop"}}',
            '{"event":"sync","reason":"file","result":{"_tag":"pushed"}}',
            '{"event":"sync","reason":"poll","result":{"_tag":"pulled"}}',
          ],
        },
        {
          title: 'watch',
          items: ['local changes debounced', 'remote polling every 30000ms'],
        },
      ],
    },
  ],
  summary: '1 file · watch active · last result pulled',
})

export const createMissingTokenFixture = (): CommandFixture => ({
  id: 'missing-token',
  command: 'notion-md status page.nmd',
  context: 'notion-md status · page.nmd',
  problems: [
    {
      severity: 'critical',
      name: 'NOTION_TOKEN',
      status: 'missing',
      details: 'command needs a Notion integration token',
      context: 'NOTION_TOKEN is required',
      fixes: ['secrets-run -- notion-md status page.nmd'],
      skips: ['notion-md sync --help'],
    },
  ],
  items: [],
  summary: '0 files · 1 missing credential',
})

export const createFixture = (id: CommandFixtureId): CommandFixture => {
  switch (id) {
    case 'clean-status':
      return createCleanStatusFixture()
    case 'body-conflict':
      return createBodyConflictFixture()
    case 'unknown-blocks':
      return createUnknownBlocksFixture()
    case 'watch-sync':
      return createWatchSyncFixture()
    case 'missing-token':
      return createMissingTokenFixture()
  }
}
