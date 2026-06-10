/*
 * Golden fidelity corpus DATA (R35). See `corpus.ts` for the schema + replay
 * harness and the capture provenance. This is a `.ts` module (not JSON) so the
 * composite tsconfig picks it up without listing JSON in the project files.
 *
 * `notion_round_trip` is captured from REAL Notion (or, until a credentialed
 * refresh, authored from the documented normalizations). `captured` records the
 * provenance; refresh it from live via the capture harness.
 */
export const fidelityCorpusData = {
  captured: 'pending-live-refresh',
  entries: [
    {
      id: 'para-after-list-756',
      issue: '#756',
      description: 'A paragraph after a list must stay a paragraph (not fold into a list item).',
      authored: '- alpha\n- beta\n\nA closing paragraph.',
      notion_round_trip: '- alpha\n- beta\n\nA closing paragraph.',
      relation: 'equal',
    },
    {
      id: 'para-after-list-as-item-756',
      issue: '#756',
      description:
        'The list-item variant of the paragraph-after-list shape; must stay DISTINCT from the paragraph variant.',
      authored: '- alpha\n- beta\n- A closing paragraph.',
      notion_round_trip: '- alpha\n- beta\n- A closing paragraph.',
      relation: 'distinct_from',
      distinct_from: 'para-after-list-756',
    },
    {
      id: 'emphasis-marker-churn-756',
      issue: '#756',
      description:
        'Notion normalizes emphasis markers (*->_, __->**) losslessly; the round-trip must reach noop.',
      authored: 'a *word* and __bold__ here',
      notion_round_trip: 'a _word_ and **bold** here',
      relation: 'equal',
    },
    {
      id: 'ordered-list-renumber-756',
      issue: '#756',
      description: 'An ordered list authored from 2. must round-trip equal to the 1.-led form.',
      authored: '2. first\n3. second\n4. third',
      notion_round_trip: '1. first\n2. second\n3. third',
      relation: 'equal',
    },
    {
      id: 'heading-vs-paragraph-763',
      issue: '#763',
      description:
        'A heading must NOT collapse into the adjacent paragraph; heading and paragraph shapes stay distinct.',
      authored: '# Section\n\nbody text',
      notion_round_trip: '# Section\n\nbody text',
      relation: 'distinct_from',
      distinct_from: 'heading-as-paragraph-763',
    },
    {
      id: 'heading-as-paragraph-763',
      issue: '#763',
      description: 'The all-paragraph variant; must stay distinct from the heading variant.',
      authored: 'Section\n\nbody text',
      notion_round_trip: 'Section\n\nbody text',
      relation: 'equal',
    },
    {
      id: 'divider-present-759',
      issue: '#759',
      description:
        'A divider must survive the round-trip and stay distinct from the divider-absent shape.',
      authored: 'before\n\n---\n\nafter',
      notion_round_trip: 'before\n\n---\n\nafter',
      relation: 'distinct_from',
      distinct_from: 'divider-absent-759',
    },
    {
      id: 'divider-absent-759',
      issue: '#759',
      description: 'The divider-absent shape; must stay distinct from the divider-present shape.',
      authored: 'before\n\nafter',
      notion_round_trip: 'before\n\nafter',
      relation: 'equal',
    },
    {
      id: 'code-fence-language',
      issue: 'fidelity',
      description: 'Code-fence language must survive; ts and js fences stay distinct.',
      authored: '```ts\nconst x = 1\n```',
      notion_round_trip: '```ts\nconst x = 1\n```',
      relation: 'distinct_from',
      distinct_from: 'code-fence-language-js',
    },
    {
      id: 'code-fence-language-js',
      issue: 'fidelity',
      description: 'The js-fence variant; must stay distinct from the ts-fence variant.',
      authored: '```js\nconst x = 1\n```',
      notion_round_trip: '```js\nconst x = 1\n```',
      relation: 'equal',
    },
  ],
} as const
