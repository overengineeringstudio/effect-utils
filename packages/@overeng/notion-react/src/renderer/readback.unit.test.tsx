import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import { BulletedListItem, Callout, Heading2, Paragraph } from '../components/blocks.ts'
import { Bold, Link } from '../components/inline.ts'
import { createFakeNotion, type FakeBlock, type FakeNotion } from '../test/mock-client.ts'
import { compareReadback, type ObservedBlockTree } from './readback.ts'
import { buildCandidateTree } from './sync-diff.ts'
import { sync } from './sync.ts'

const ROOT = '00000000-0000-4000-8000-000000000001'

const runWith = <A, E>(
  fake: FakeNotion,
  eff: Effect.Effect<A, E, HttpClient.HttpClient | NotionConfig>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(fake.layer)))

/** Read the fake server's live tree back as public-API-shaped block JSON. */
const observeFake = (fake: FakeNotion, parentId: string): readonly ObservedBlockTree[] =>
  fake.childrenOf(parentId).map(
    (b: FakeBlock): ObservedBlockTree => ({
      block: { object: 'block', id: b.id, type: b.type, [b.type]: b.payload },
      children: observeFake(fake, b.id),
    }),
  )

const element: ReactNode = (
  <>
    <Paragraph>
      Hello <Bold>world</Bold> and <Link href="https://overeng.dev">a link</Link>
    </Paragraph>
    <Heading2>Section</Heading2>
    <BulletedListItem>
      item one
      <Paragraph>nested detail</Paragraph>
    </BulletedListItem>
    <Callout icon="⚠️" color="red_background">
      warning text
    </Callout>
    <Callout>plain callout without icon claim</Callout>
  </>
)

/** Response-shape text run with the derived fields real Notion adds. */
const run = (
  text: string,
  overrides?: { readonly bold?: boolean; readonly link?: string },
): Record<string, unknown> => ({
  type: 'text',
  text: { content: text, link: overrides?.link !== undefined ? { url: overrides.link } : null },
  plain_text: text,
  href: overrides?.link ?? null,
  annotations: {
    bold: overrides?.bold ?? false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: 'default',
  },
})

describe('readback normalization oracle', () => {
  it('mock roundtrip: render → sync → observe → hash equality', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    await runWith(fake, sync(element, { pageId: ROOT, cache }))
    const candidate = buildCandidateTree(element, ROOT)
    const observed = observeFake(fake, ROOT)
    const cmp = compareReadback({ candidate, observed })
    expect(cmp.equal).toBe(true)
    expect(cmp.observedHash).toBe(cmp.candidateHash)
    // The hash is a pure function of the element: a fresh render agrees.
    expect(compareReadback({ candidate: buildCandidateTree(element, ROOT), observed }).candidateHash).toBe(
      cmp.candidateHash,
    )
  })

  it('normalizes realistic response-shape readback into the candidate hash space', () => {
    const candidate = buildCandidateTree(
      <>
        <Paragraph>
          Hello <Bold>world</Bold>
        </Paragraph>
        <Callout>no icon</Callout>
      </>,
      ROOT,
    )
    const observed: ObservedBlockTree[] = [
      {
        block: {
          object: 'block',
          id: 'b1',
          type: 'paragraph',
          paragraph: {
            color: 'default', // response always carries the default explicitly
            rich_text: [
              run('Hel'), // Notion re-segmented the default-frame text —
              run('lo '), // adjacent identical frames must coalesce
              run('world', { bold: true }),
            ],
          },
        },
        children: [],
      },
      {
        block: {
          object: 'block',
          id: 'b2',
          type: 'callout',
          callout: {
            color: 'default',
            // Provider-injected default icon for an authored-null icon: the
            // JSX never claimed one, so this field is provider-owned.
            icon: { type: 'external', external: { url: 'https://www.notion.so/icons/star.svg' } },
            rich_text: [run('no icon')],
          },
        },
        children: [],
      },
    ]
    const cmp = compareReadback({ candidate, observed })
    expect(cmp.equal).toBe(true)
  })

  it('detects real content drift: text change and explicit-icon change both break equality', () => {
    const candidate = buildCandidateTree(
      <Callout icon="⚠️">exact warning</Callout>,
      ROOT,
    )
    const observedOk: ObservedBlockTree[] = [
      {
        block: {
          id: 'b1',
          type: 'callout',
          callout: {
            color: 'default',
            icon: { type: 'emoji', emoji: '⚠️' },
            rich_text: [run('exact warning')],
          },
        },
        children: [],
      },
    ]
    expect(compareReadback({ candidate, observed: observedOk }).equal).toBe(true)

    const changedText = structuredClone(observedOk) as typeof observedOk
    ;((changedText[0]!.block.callout as Record<string, unknown>).rich_text as unknown[])[0] =
      run('tampered warning')
    expect(compareReadback({ candidate, observed: changedText }).equal).toBe(false)

    const changedIcon = structuredClone(observedOk) as typeof observedOk
    ;(changedIcon[0]!.block.callout as Record<string, unknown>).icon = {
      type: 'emoji',
      emoji: '🎯',
    }
    // Explicit JSX icons are exact managed content — no provider tolerance.
    expect(compareReadback({ candidate, observed: changedIcon }).equal).toBe(false)
  })
})
