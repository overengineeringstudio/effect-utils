import { describe, expect, it } from '@effect/vitest'

import {
  fingerprintBodyEvidence,
  makeRemoteBodyObservationEvidence,
  type NotionBodyObservation,
} from '@overeng/notion-effect-client'

import { remoteMarkdownFromBodyObservation } from './live.ts'

const observedAt = '2026-06-09T00:00:00.000Z'

const evidenceFor = (input: {
  readonly pageId: string
  readonly endpointMarkdown: string
  readonly renderedMarkdown: string
  readonly entries: NotionBodyObservation['inventory']['entries']
  readonly completeness: 'complete' | 'lossy'
}) => {
  const evidence = makeRemoteBodyObservationEvidence({
    pageId: input.pageId,
    observedAt,
    beforeLastEditedTime: observedAt,
    afterLastEditedTime: observedAt,
    endpointMarkdown: input.endpointMarkdown,
    renderedMarkdown: input.renderedMarkdown,
    inventoryEntries: input.entries,
    blockTree: input.entries.map((entry) => ({
      block: {
        id: entry.id,
        type: entry.type,
        has_children: entry.hasChildren,
        in_trash: entry.inTrash,
      },
      children: [],
    })),
    completeness: input.completeness,
  })
  return { evidence, evidenceFingerprint: fingerprintBodyEvidence(evidence) }
}

/*
 * `observeFromSnapshots` now canonicalizes `renderedMarkdown` at the source
 * (body-observation.ts), so these inputs are the already-canonical body and
 * `remoteMarkdownFromBodyObservation` projects it through verbatim. The
 * canonicalization behavior itself is locked in canonical-markdown.unit.test.ts
 * and body-observation.unit.test.ts; here we assert the projection and that the
 * endpoint Markdown is never adopted in place of the rendered body.
 */
describe('remoteMarkdownFromBodyObservation', () => {
  it('adopts block-tree-rendered Markdown instead of endpoint Markdown', () => {
    const entries = [
      {
        id: '00000000-0000-4000-8000-000000000002',
        type: 'heading_2',
        hasChildren: false,
        inTrash: false,
      },
      {
        id: '00000000-0000-4000-8000-000000000003',
        type: 'paragraph',
        hasChildren: false,
        inTrash: false,
      },
      {
        id: '00000000-0000-4000-8000-000000000004',
        type: 'divider',
        hasChildren: false,
        inTrash: false,
      },
    ] as const
    const observation: NotionBodyObservation = {
      pageId: '00000000-0000-4000-8000-000000000001',
      markdown: {
        markdown: '## Section\nParagraph that the endpoint left adjacent\n---\n',
        truncated: false,
        unknownBlockIds: [],
      },
      inventory: {
        entries,
        renderedMarkdown: '## Section\n\nParagraph that the endpoint left adjacent\n\n---\n',
      },
      completeness: { _tag: 'complete' },
      ...evidenceFor({
        pageId: '00000000-0000-4000-8000-000000000001',
        endpointMarkdown: '## Section\nParagraph that the endpoint left adjacent\n---\n',
        renderedMarkdown: '## Section\n\nParagraph that the endpoint left adjacent\n\n---\n',
        entries,
        completeness: 'complete',
      }),
    }

    expect(remoteMarkdownFromBodyObservation(observation)).toMatchObject({
      markdown: '## Section\n\nParagraph that the endpoint left adjacent\n\n---\n',
      endpoint_markdown: '## Section\nParagraph that the endpoint left adjacent\n---\n',
      truncated: false,
      unknown_block_ids: [],
      completeness: { _tag: 'complete' },
      body_evidence_fingerprint: observation.evidenceFingerprint,
    })
  })

  it('projects the canonical (tight) list body through to the pull snapshot', () => {
    const entries = [
      {
        id: '00000000-0000-4000-8000-000000000002',
        type: 'bulleted_list_item',
        hasChildren: false,
        inTrash: false,
      },
      {
        id: '00000000-0000-4000-8000-000000000003',
        type: 'bulleted_list_item',
        hasChildren: false,
        inTrash: false,
      },
      {
        id: '00000000-0000-4000-8000-000000000004',
        type: 'paragraph',
        hasChildren: false,
        inTrash: false,
      },
    ] as const
    // `observeFromSnapshots` already canonicalized the loose renderer output to
    // this tight form; the projection passes it through, keeping the blank line
    // before the trailing paragraph.
    const renderedMarkdown = '- Bullet A\n- Bullet B\n\nA paragraph after the list.\n'
    const observation: NotionBodyObservation = {
      pageId: '00000000-0000-4000-8000-000000000001',
      markdown: {
        markdown: '- Bullet A\n- Bullet B\nA paragraph after the list.\n',
        truncated: false,
        unknownBlockIds: [],
      },
      inventory: { entries, renderedMarkdown },
      completeness: { _tag: 'complete' },
      ...evidenceFor({
        pageId: '00000000-0000-4000-8000-000000000001',
        endpointMarkdown: '- Bullet A\n- Bullet B\nA paragraph after the list.\n',
        renderedMarkdown,
        entries,
        completeness: 'complete',
      }),
    }

    expect(remoteMarkdownFromBodyObservation(observation)).toMatchObject({
      markdown: '- Bullet A\n- Bullet B\n\nA paragraph after the list.\n',
    })
  })

  it('never runs consecutive headings together on pull', () => {
    // The endpoint Markdown drops inter-block blank lines (headings run
    // together); the canonical rendered body must keep them blank-separated.
    const entries = [
      {
        id: '00000000-0000-4000-8000-000000000002',
        type: 'heading_1',
        hasChildren: false,
        inTrash: false,
      },
      {
        id: '00000000-0000-4000-8000-000000000003',
        type: 'heading_2',
        hasChildren: false,
        inTrash: false,
      },
      {
        id: '00000000-0000-4000-8000-000000000004',
        type: 'heading_3',
        hasChildren: false,
        inTrash: false,
      },
    ] as const
    const renderedMarkdown = '# H1\n\n## H2\n\n### H3\n'
    const observation: NotionBodyObservation = {
      pageId: '00000000-0000-4000-8000-000000000001',
      // Endpoint shape with headings run together — must NOT leak through.
      markdown: { markdown: '# H1\n## H2\n### H3\n', truncated: false, unknownBlockIds: [] },
      inventory: { entries, renderedMarkdown },
      completeness: { _tag: 'complete' },
      ...evidenceFor({
        pageId: '00000000-0000-4000-8000-000000000001',
        endpointMarkdown: '# H1\n## H2\n### H3\n',
        renderedMarkdown,
        entries,
        completeness: 'complete',
      }),
    }

    expect(remoteMarkdownFromBodyObservation(observation)).toMatchObject({
      markdown: '# H1\n\n## H2\n\n### H3\n',
    })
  })

  it('throws an invariant defect when block-tree-rendered Markdown is unavailable', () => {
    const entries = [] as const
    const observation: NotionBodyObservation = {
      pageId: '00000000-0000-4000-8000-000000000001',
      markdown: { markdown: 'Endpoint only', truncated: false, unknownBlockIds: [] },
      inventory: { entries },
      completeness: { _tag: 'complete' },
      ...evidenceFor({
        pageId: '00000000-0000-4000-8000-000000000001',
        endpointMarkdown: 'Endpoint only',
        renderedMarkdown: '',
        entries,
        completeness: 'complete',
      }),
    }

    expect(() => remoteMarkdownFromBodyObservation(observation)).toThrow(
      /has no rendered Markdown/u,
    )
  })
})
