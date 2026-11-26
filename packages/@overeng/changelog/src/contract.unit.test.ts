import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { ChangelogCompileError, compileChangelog, identityFromFilename } from './compiler.ts'
import { makeChangelogContract, NonEmptyTrimmedString } from './contract.ts'

const Localized = Schema.Struct({ de: NonEmptyTrimmedString, en: NonEmptyTrimmedString })
const games = makeChangelogContract({
  product: 'games',
  text: Localized,
  fields: {
    games: Schema.Union([
      Schema.Literal('general'),
      Schema.NonEmptyArray(Schema.Literals(['chess', 'wizard'])),
    ]),
  },
})
/** Vista's shape: plain strings plus optional contributors. */
const vista = makeChangelogContract({
  product: 'vista',
  text: NonEmptyTrimmedString,
  fields: {
    contributors: Schema.optional(
      Schema.NonEmptyArray(Schema.Struct({ agentId: NonEmptyTrimmedString })),
    ),
  },
})

const text = (de: string, en = de) => ({ de, en })

describe('identityFromFilename', () => {
  it('takes id and date from the filename only', () => {
    expect(identityFromFilename('2026-11-22-wizard-trump.ts')).toEqual({
      id: '2026-11-22-wizard-trump',
      date: '2026-11-22',
    })
  })

  it.each(['2026-11-22.ts', '2026-11-22-Wizard.ts', '26-11-22-x.ts', '2026-11-22-x.scene.ts'])(
    'rejects %s',
    (file) => {
      expect(() => identityFromFilename(file)).toThrow(ChangelogCompileError)
    },
  )

  it('rejects impossible calendar dates', () => {
    expect(() => identityFromFilename('2026-02-30-leap.ts')).toThrow(/calendar date/)
  })
})

describe('makeChangelogContract', () => {
  it('decodes product fields and rejects unknown ones', () => {
    const source = { title: text('Neu'), summary: text('Mehr'), games: ['wizard'] }
    expect(games.decodeEntrySource(source)).toEqual(source)
    expect(() => games.decodeEntrySource({ ...source, extra: true })).toThrow()
    expect(() => games.decodeEntrySource({ ...source, title: { de: 'Nur Deutsch' } })).toThrow()
    expect(() => games.decodeEntrySource({ ...source, games: [] })).toThrow()
  })

  it('fits plain-string products such as Vista', () => {
    const source = {
      title: 'RPC diagnostics',
      summary: 'Share the operator bar.',
      contributors: [{ agentId: 'dev3.direct.omp.x' }] as const,
    }
    const { manifest } = compileChangelog({
      contract: vista,
      registrations: [{ file: '2026-09-29-operator-devbar.ts', source }],
      machineVersion: '0.1.0+7d5211e',
    })
    expect(manifest).toEqual({
      schemaVersion: 1,
      product: 'vista',
      build: { machineVersion: '0.1.0+7d5211e' },
      entries: [{ id: '2026-09-29-operator-devbar', date: '2026-09-29', ...source }],
    })
  })
})

describe('compileChangelog', () => {
  const screenshot = {
    alt: text('Gebotsleiste'),
    crop: { target: '[data-testid="bid"]', padding: 12 },
    annotations: [
      { kind: 'ring', n: 2, target: '#b', caption: text('Zwei') },
      { kind: 'arrow', target: '#a', from: { dx: -40, dy: 30 } },
      { kind: 'ring', n: 1, target: '#a', caption: text('Eins') },
    ],
  } as const
  const image = {
    viewport: 'phone',
    scheme: 'light',
    src: './changelog/a.png',
    width: 390,
    height: 200,
  } as const

  it('sorts newest first, stamps the build and publishes callouts in number order', () => {
    const { manifest, bytes } = compileChangelog({
      contract: games,
      machineVersion: '0.1.0+abc',
      registrations: [
        {
          file: '2026-11-20-older.ts',
          source: { title: text('A'), summary: text('a'), games: 'general' },
        },
        {
          file: '2026-11-22-newer.ts',
          source: { title: text('B'), summary: text('b'), games: ['wizard'], screenshot },
          images: [image],
        },
      ],
    })
    expect(manifest.entries.map((entry) => entry.id)).toEqual([
      '2026-11-22-newer',
      '2026-11-20-older',
    ])
    expect(manifest.entries[0]?.screenshot).toEqual({
      alt: text('Gebotsleiste'),
      images: [image],
      callouts: [
        { n: 1, caption: text('Eins') },
        { n: 2, caption: text('Zwei') },
      ],
    })
    expect(games.decodeManifest(JSON.parse(bytes))).toEqual(manifest)
    expect(bytes.endsWith('\n')).toBe(true)
  })

  it('requires rendered images for screenshot entries', () => {
    expect(() =>
      compileChangelog({
        contract: games,
        machineVersion: 'v',
        registrations: [
          {
            file: '2026-11-22-x.ts',
            source: { title: text('B'), summary: text('b'), games: ['wizard'], screenshot },
          },
        ],
      }),
    ).toThrow(/none is rendered/)
  })

  it('rejects gaps in ring numbering and duplicate ids', () => {
    const gappy = {
      ...screenshot,
      annotations: [{ kind: 'ring', n: 2, target: '#a', caption: text('Zwei') }],
    } as const
    expect(() =>
      compileChangelog({
        contract: games,
        machineVersion: 'v',
        registrations: [
          {
            file: '2026-11-22-x.ts',
            source: { title: text('B'), summary: text('b'), games: ['wizard'], screenshot: gappy },
            images: [image],
          },
        ],
      }),
    ).toThrow(/numbered 1…1/)
    const source = { title: text('A'), summary: text('a'), games: 'general' } as const
    expect(() =>
      compileChangelog({
        contract: games,
        machineVersion: 'v',
        registrations: [
          { file: '2026-11-22-x.ts', source },
          { file: '2026-11-22-x.ts', source },
        ],
      }),
    ).toThrow(/duplicate/)
  })
})
