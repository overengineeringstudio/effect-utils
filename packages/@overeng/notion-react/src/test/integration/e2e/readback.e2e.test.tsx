import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { NotionPages } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../../../cache/in-memory-cache.ts'
import {
  Bookmark,
  BulletedListItem,
  Callout,
  Code,
  Column,
  ColumnList,
  Divider,
  Embed,
  Equation,
  Heading2,
  Heading3,
  Image,
  NumberedListItem,
  Page,
  Paragraph,
  Quote,
  Table,
  TableOfContents,
  TableRow,
  ToDo,
  Toggle,
} from '../../../components/blocks.ts'
import { Bold, InlineEquation, Italic, Link } from '../../../components/inline.ts'
import { observeBlockTree } from '../../../renderer/readback-observe.ts'
import { compareReadback, compareReadbackPage } from '../../../renderer/readback.ts'
import { buildCandidateTree } from '../../../renderer/sync-diff.ts'
import { sync } from '../../../renderer/sync.ts'
import { SKIP_E2E, withScratchPage } from './helpers.ts'
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/**
 * Live-API coverage for the readback oracle. The mock stores request-shape
 * payloads, so mock roundtrips cannot exercise the response-shape deltas the
 * oracle exists to absorb (decorated rich text, re-segmented runs, explicit
 * defaults, provider-injected callout icons, `plain_text`/`href` extras) —
 * only the real API produces those. Each test syncs a JSX tree to a scratch
 * page, observes the live block tree back, and asserts hash equality plus a
 * tamper-detection negative.
 */

const DEFAULT_TIMEOUT = 60_000

describe.skipIf(SKIP_E2E)('readback oracle against the live API (e2e)', () => {
  it(
    'full-surface roundtrip: sync → observe → compareReadback equal',
    async () => {
      const element = (
        <>
          <Paragraph>
            Hello <Bold>world</Bold> and <Italic>emphasis</Italic> plus{' '}
            <Link href="https://example.com/x">a link</Link>
          </Paragraph>
          <Heading2 toggleable color="blue">
            Section
          </Heading2>
          <Heading3>Plain section</Heading3>
          <BulletedListItem>
            item one
            <Paragraph>nested detail</Paragraph>
          </BulletedListItem>
          <NumberedListItem>first</NumberedListItem>
          <ToDo checked>done</ToDo>
          <Quote>quoted</Quote>
          <Callout icon="⚠️" color="red_background">
            warning
          </Callout>
          <Callout>no icon claimed — server injects a default</Callout>
          <Toggle title="More">
            <Paragraph>hidden</Paragraph>
          </Toggle>
          <Code language="typescript">const x = 1</Code>
          <Divider />
          <TableOfContents />
          <Equation expression="e = mc^2" />
          <Bookmark url="https://example.com" />
          <Embed url="https://example.com/embed" />
          <Image url="https://picsum.photos/64" caption="a picture" />
          <Table tableWidth={2} hasColumnHeader>
            <TableRow cells={['a', 'b']} />
            <TableRow cells={[<Bold key="c">c</Bold>, 'd']} />
          </Table>
          <ColumnList>
            <Column>
              <Paragraph>left</Paragraph>
            </Column>
            <Column>
              <Paragraph>right</Paragraph>
            </Column>
          </ColumnList>
          <Paragraph>
            inline <InlineEquation expression="x^2" /> equation
          </Paragraph>
        </>
      )
      await withScratchPage('readback-full-surface', (pageId) =>
        Effect.gen(function* () {
          yield* sync(element, { pageId, cache: InMemoryCache.make() })
          const observed = yield* observeBlockTree({ blockId: pageId })
          const cmp = compareReadback({ candidate: buildCandidateTree(element, pageId), observed })
          if (!cmp.equal) {
            // Surface the normalized trees on failure — the diff IS the finding.
            console.error('candidate', encodeJson(cmp.candidate))
            console.error('observed', encodeJson(cmp.observed))
          }
          expect(cmp.equal).toBe(true)

          // Negative: a drifted element must not hash-collide with the page.
          const tampered = buildCandidateTree(<Paragraph>something else</Paragraph>, pageId)
          expect(compareReadback({ candidate: tampered, observed }).equal).toBe(false)
        }),
      )
    },
    DEFAULT_TIMEOUT * 3,
  )

  it(
    'page metadata roundtrip: title + icon claims verify via pages.retrieve',
    async () => {
      const title = 'readback metadata probe'
      const icon = { type: 'emoji', emoji: '🎯' } as const
      const element = (
        <Page title={title} icon={icon}>
          <Paragraph>body</Paragraph>
        </Page>
      )
      await withScratchPage('readback-page-metadata', (pageId) =>
        Effect.gen(function* () {
          yield* sync(element, { pageId, cache: InMemoryCache.make() })
          const page = (yield* NotionPages.retrieve({ pageId })) as Record<string, unknown>
          const candidate = buildCandidateTree(element, pageId)
          const cmp = compareReadbackPage({ candidate: candidate.rootPage ?? {}, observed: page })
          expect(cmp.equal).toBe(true)
          expect(
            compareReadbackPage({
              candidate: { title: [{ type: 'text', text: { content: 'other title' } }] },
              observed: page,
            }).equal,
          ).toBe(false)
        }),
      )
    },
    DEFAULT_TIMEOUT * 2,
  )
})
