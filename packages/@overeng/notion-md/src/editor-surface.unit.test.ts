import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  editorBaseHash,
  parseTitleBody,
  serializeTitleBody,
  type TitleBodyDocument,
} from './editor-surface.ts'

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

describe('serializeTitleBody', () => {
  it('titled + body: `# title` then a blank line then body', () => {
    expect(serializeTitleBody({ title: 'Hello', body: 'world' })).toBe('# Hello\n\nworld\n')
  })

  it('titled + empty body: just the title line', () => {
    expect(serializeTitleBody({ title: 'Hello', body: '' })).toBe('# Hello\n')
  })

  it('untitled + empty body is exactly `# \\n`', () => {
    expect(serializeTitleBody({ title: '', body: '' })).toBe('# \n')
  })

  it('untitled + body keeps the empty title line', () => {
    expect(serializeTitleBody({ title: '', body: 'body' })).toBe('# \n\nbody\n')
  })

  it('preserves a body that has its own leading H1 verbatim', () => {
    expect(serializeTitleBody({ title: 'Title', body: '# Body Heading\n\ntext' })).toBe(
      '# Title\n\n# Body Heading\n\ntext\n',
    )
  })
})

describe('parseTitleBody', () => {
  it('splits a titled body', () =>
    run(
      Effect.gen(function* () {
        const doc = yield* parseTitleBody({ buffer: '# Hello\n\nworld\n' })
        expect(doc).toEqual({ title: 'Hello', body: 'world\n' })
      }),
    ))

  it('parses an untitled page (bare `# `)', () =>
    run(
      Effect.gen(function* () {
        const doc = yield* parseTitleBody({ buffer: '# \n' })
        expect(doc).toEqual({ title: '', body: '' })
      }),
    ))

  it('parses a bare `#` (no trailing space) as untitled', () =>
    run(
      Effect.gen(function* () {
        const doc = yield* parseTitleBody({ buffer: '#\n' })
        expect(doc).toEqual({ title: '', body: '' })
      }),
    ))

  it('line 1 wins: a body with its own leading H1 keeps it as body content', () =>
    run(
      Effect.gen(function* () {
        const doc = yield* parseTitleBody({ buffer: '# Title\n\n# Body Heading\n\ntext\n' })
        expect(doc).toEqual({ title: 'Title', body: '# Body Heading\n\ntext\n' })
      }),
    ))

  it('refuses a buffer whose line 1 is not a `# ` heading (exit 5)', () =>
    run(
      Effect.gen(function* () {
        const result = yield* Effect.result(parseTitleBody({ buffer: 'no heading\nbody\n' }))
        expect(result._tag).toBe('Failure')
        if (result._tag === 'Failure') expect(result.failure._tag).toBe('NmdInvalidDocumentError')
      }),
    ))

  it('refuses a Setext-style heading (line 2 underline is not line-1 `# `)', () =>
    run(
      Effect.gen(function* () {
        const result = yield* Effect.result(parseTitleBody({ buffer: 'Title\n=====\n' }))
        expect(result._tag).toBe('Failure')
      }),
    ))
})

describe('serialize ∘ parse round-trips (cat→put fixpoint)', () => {
  const cases: ReadonlyArray<TitleBodyDocument> = [
    { title: 'Hello', body: 'world' },
    { title: 'Hello', body: '' },
    { title: '', body: '' },
    { title: '', body: 'body' },
    { title: 'Title', body: '# Body Heading\n\ntext' },
    { title: 'Multi line', body: 'line 1\n\nline 2\n\n- a\n- b' },
    { title: 'Trailing ws', body: 'text   ' },
  ]

  it.each(cases)('parse(serialize(%j)) is a fixpoint', (doc) =>
    run(
      Effect.gen(function* () {
        const serialized = serializeTitleBody(doc)
        const parsed = yield* parseTitleBody({ buffer: serialized })
        // Re-serializing the parsed document is byte-identical: this is the
        // idempotence the cat→put round-trip relies on.
        expect(serializeTitleBody(parsed)).toBe(serialized)
        expect(editorBaseHash(parsed)).toBe(editorBaseHash(doc))
      }),
    ),
  )
})

describe('editorBaseHash', () => {
  it('covers title and body together (a title-only change moves the hash)', () => {
    const a = editorBaseHash({ title: 'A', body: 'same' })
    const b = editorBaseHash({ title: 'B', body: 'same' })
    expect(a).not.toBe(b)
  })

  it('is a `sha256:`-prefixed digest', () => {
    expect(editorBaseHash({ title: 'X', body: 'y' })).toMatch(/^sha256:[0-9a-f]{64}$/u)
  })
})
