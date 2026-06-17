import { Schema } from 'effect'

import { fidelityCorpusData } from './corpus/fidelity-corpus.ts'

/*
 * The golden fidelity corpus (R35).
 *
 * A corpus of historically-broken Notion body shapes, replayed OFFLINE so it
 * gates every change without network access. Each entry pins one shape and the
 * R33 canonical relation the engine must hold for it: `equal` (authored and the
 * Notion round-trip are semantically equal — fidelity preserved, must reach
 * noop) or `distinct_from` (the shape must NOT be folded into a named sibling).
 *
 * `notion_round_trip` is, by intent, captured from REAL Notion through the
 * live corpus refresh path — a hand-written fake re-bakes the blind spots that
 * let #756/#759/#763 through. The schema and replay harness are the durable
 * part, so future refreshes are reviewed data updates, not code changes.
 */

/** R33 relation an entry asserts against its own round-trip or a sibling. */
export const CorpusRelation = Schema.Literal('equal', 'distinct_from').annotations({
  identifier: 'NotionMd.Corpus.Relation',
})

/** One historically-broken Notion body shape and the relation it must hold. */
export const CorpusEntry = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  issue: Schema.String,
  description: Schema.String,
  /** What a user authors locally. */
  authored: Schema.String,
  /** The block-tree-rendered body a real Notion round-trip produces. */
  notion_round_trip: Schema.String,
  relation: CorpusRelation,
  /** For `distinct_from`, the sibling entry id whose canonical form must differ. */
  distinct_from: Schema.optional(Schema.String),
}).annotations({ identifier: 'NotionMd.Corpus.Entry' })

export type CorpusEntry = typeof CorpusEntry.Type

/** The corpus document (offline-replayable; periodically refreshed from live). */
export const Corpus = Schema.Struct({
  captured: Schema.String,
  entries: Schema.Array(CorpusEntry),
}).annotations({ identifier: 'NotionMd.Corpus' })

export type Corpus = typeof Corpus.Type

const decodeCorpus = Schema.decodeUnknownSync(Corpus, {
  onExcessProperty: 'preserve',
})

/** The decoded golden corpus, ready for offline replay. */
export const fidelityCorpus: Corpus = decodeCorpus(fidelityCorpusData)

/** Look up a corpus entry by id (for `distinct_from` resolution). */
export const corpusEntry = (id: string): CorpusEntry | undefined =>
  fidelityCorpus.entries.find((entry) => entry.id === id)
