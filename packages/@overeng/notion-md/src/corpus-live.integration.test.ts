import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { Effect, Layer, Redacted } from 'effect'
import { afterAll, describe, expect, it } from 'vitest'

import {
  NotionBody,
  NotionConfigLive,
  NotionPages,
  type NotionConfig,
} from '@overeng/notion-effect-client'

import { canonicalize, semanticEqual } from './canonicalizer.ts'
import { fidelityCorpus, type CorpusEntry } from './corpus.ts'
import { remoteMarkdownFromBodyObservation } from './live.ts'

const token = process.env.NOTION_API_TOKEN
const testParentPageId = process.env.NOTION_TEST_PARENT_PAGE_ID
const skipLive =
  token === undefined ||
  token.length === 0 ||
  testParentPageId === undefined ||
  testParentPageId.length === 0

const ConfigLayer = NotionConfigLive({
  authToken: Redacted.make(token ?? ''),
  retryEnabled: true,
  maxRetries: 5,
  retryBaseDelay: 1000,
})
const TestLayer = Layer.mergeAll(ConfigLayer, FetchHttpClient.layer)

type LiveEnv = NotionConfig | HttpClient.HttpClient

const runLive = <A, E>(effect: Effect.Effect<A, E, LiveEnv>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(TestLayer))))

const createdPageIds: string[] = []

const pageTitle = (entry: CorpusEntry) => `notion-md corpus: ${entry.id}`

const normalize = (markdown: string) => markdown.replace(/\r\n?/g, '\n').trim()

const captureEntry = (entry: CorpusEntry) =>
  Effect.gen(function* () {
    const page = yield* NotionPages.create({
      parent: { type: 'page_id', page_id: testParentPageId ?? '' },
      properties: {
        title: {
          title: [{ type: 'text', text: { content: pageTitle(entry) } }],
        },
      },
    })
    createdPageIds.push(page.id)

    yield* NotionPages.updateMarkdown({
      pageId: page.id,
      type: 'replace_content',
      new_str: entry.authored,
      allow_deleting_content: true,
    })

    const body = yield* NotionBody.observe({ pageId: page.id })
    return {
      ...entry,
      notion_round_trip: normalize(remoteMarkdownFromBodyObservation(body).markdown),
    }
  })

const renderCorpus = (opts: {
  readonly captured: string
  readonly entries: readonly CorpusEntry[]
}): string => {
  const renderedEntries = opts.entries
    .map((entry) =>
      [
        '    {',
        `      id: ${JSON.stringify(entry.id)},`,
        `      issue: ${JSON.stringify(entry.issue)},`,
        `      description: ${JSON.stringify(entry.description)},`,
        `      authored: ${JSON.stringify(entry.authored)},`,
        `      notion_round_trip: ${JSON.stringify(entry.notion_round_trip)},`,
        `      relation: ${JSON.stringify(entry.relation)},`,
        ...(entry.distinct_from === undefined
          ? []
          : [`      distinct_from: ${JSON.stringify(entry.distinct_from)},`]),
        '    },',
      ].join('\n'),
    )
    .join('\n')

  return `/*
 * Golden fidelity corpus DATA (R35). See \`corpus.ts\` for the schema + replay
 * harness and the capture provenance. This is a \`.ts\` module (not JSON) so the
 * composite tsconfig picks it up without listing JSON in the project files.
 *
 * \`notion_round_trip\` is captured from REAL Notion. \`captured\` records the
 * provenance; refresh it from live via:
 *
 * NOTION_MD_CAPTURE_CORPUS=1 NOTION_API_TOKEN=... NOTION_TEST_PARENT_PAGE_ID=... \\
 *   pnpm --dir packages/@overeng/notion-md exec vitest run src/corpus-live.integration.test.ts --config vitest.integration.config.ts
 */
export const fidelityCorpusData = {
  captured: ${JSON.stringify(opts.captured)},
  entries: [
${renderedEntries}
  ],
} as const
`
}

const assertCorpusRelations = (entries: readonly CorpusEntry[]) => {
  for (const entry of entries) {
    if (entry.relation === 'equal') {
      expect(semanticEqual({ a: entry.authored, b: entry.notion_round_trip }), entry.id).toBe(true)
      continue
    }

    const sibling = entries.find((candidate) => candidate.id === entry.distinct_from)
    expect(sibling, `${entry.id} references ${entry.distinct_from}`).not.toBeUndefined()
    expect(canonicalize(entry.notion_round_trip), entry.id).not.toBe(
      canonicalize(sibling?.notion_round_trip ?? ''),
    )
  }
}

afterAll(async () => {
  if (skipLive === true) return
  for (const pageId of createdPageIds) {
    await runLive(NotionPages.archive({ pageId }).pipe(Effect.ignore)).catch(() => undefined)
  }
})

describe.skipIf(skipLive)('notion-md live fidelity corpus capture (R35)', () => {
  it('captures the checked corpus from real Notion and optionally refreshes the fixture', async () => {
    const captured = await runLive(
      Effect.forEach(fidelityCorpus.entries, captureEntry, { concurrency: 1 }),
    )

    assertCorpusRelations(captured)

    if (process.env.NOTION_MD_CAPTURE_CORPUS === '1') {
      const path = fileURLToPath(new URL('./corpus/fidelity-corpus.ts', import.meta.url))
      await writeFile(
        path,
        renderCorpus({
          captured: `live-notion:${new Date().toISOString()}`,
          entries: captured,
        }),
      )
      return
    }

    expect(captured.map((entry) => entry.notion_round_trip)).toEqual(
      fidelityCorpus.entries.map((entry) => entry.notion_round_trip),
    )
  }, 120_000)
})
