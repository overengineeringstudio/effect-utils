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
        renderedMarkdown: '## Section\n\nParagraph that the endpoint left adjacent\n\n---',
      },
      completeness: { _tag: 'complete' },
      ...evidenceFor({
        pageId: '00000000-0000-4000-8000-000000000001',
        endpointMarkdown: '## Section\nParagraph that the endpoint left adjacent\n---\n',
        renderedMarkdown: '## Section\n\nParagraph that the endpoint left adjacent\n\n---',
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

  it('fails closed when block-tree-rendered Markdown is unavailable', () => {
    const entries = [] as const
    const observation: NotionBodyObservation = {
      pageId: '00000000-0000-4000-8000-000000000001',
      markdown: {
        markdown: 'Endpoint only',
        truncated: false,
        unknownBlockIds: [],
      },
      inventory: {
        entries,
      },
      completeness: { _tag: 'complete' },
      ...evidenceFor({
        pageId: '00000000-0000-4000-8000-000000000001',
        endpointMarkdown: 'Endpoint only',
        renderedMarkdown: '',
        entries,
        completeness: 'complete',
      }),
    }

    expect(remoteMarkdownFromBodyObservation(observation)).toMatchObject({
      markdown: 'Endpoint only\n',
      endpoint_markdown: 'Endpoint only\n',
      truncated: false,
      unknown_block_ids: [],
      body_evidence_fingerprint: observation.evidenceFingerprint,
      completeness: {
        _tag: 'lossy',
        reasons: ['rendered_markdown_unavailable'],
      },
    })
  })
})
