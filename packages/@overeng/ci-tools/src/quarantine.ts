/**
 * Test-quarantine contract: what a tolerated test failure is, and how CI is told about one.
 *
 * A quarantine lets a known-failing test target stay non-blocking without the required check
 * lying about it. Two properties keep it from becoming permanent and invisible, and both live
 * here so every consuming repo gets the same semantics:
 *
 * - **Expiry.** {@link expiredQuarantineEntries} fails an entry once its `expires` date passes,
 *   forcing a renew-or-remove decision.
 * - **Distinguishable signal.** {@link renderQuarantineAnnouncement} names the target, reason,
 *   issue, and expiry, and the announcement is written where CI actually reads it.
 *
 * The repo owns the ledger contents; this module owns what a ledger entry means.
 *
 * Contract: `context/ci-tools/01-quarantine/` (requirements R01–R08, spec).
 */

import { Schema } from 'effect'

/** A single tolerated test failure, and the record that justifies tolerating it. */
export const QuarantineEntry = Schema.Struct({
  /** What is quarantined — a package path, provider key, or suite name. */
  target: Schema.NonEmptyString,
  /** Why its failures are currently tolerated. */
  reason: Schema.NonEmptyString,
  /** Issue tracking the underlying problem. */
  issue: Schema.NonEmptyString,
  /** `YYYY-MM-DD`. Past this date the entry is expired and the ledger check fails. */
  expires: Schema.NonEmptyString,
}).annotate({ identifier: 'CiTools.Quarantine.Entry' })
export type QuarantineEntry = typeof QuarantineEntry.Type

/** Every currently-tolerated test failure in a repository, keyed by quarantine key. */
export const QuarantineLedger = Schema.Record({
  key: Schema.String,
  value: QuarantineEntry,
}).annotate({ identifier: 'CiTools.Quarantine.Ledger' })
export type QuarantineLedger = typeof QuarantineLedger.Type

/** Parses ledger JSON, rejecting entries that omit a target, reason, issue, or expiry. */
export const decodeQuarantineLedgerJson = Schema.decodeUnknownSync(
  Schema.parseJson(QuarantineLedger),
)

/**
 * Entries that are expired relative to `today` (`YYYY-MM-DD`).
 *
 * A malformed `expires` counts as expired. Comparison is lexicographic, so any free-form
 * string (`'someday'`) sorts above every real date and would otherwise never expire — turning
 * a typo into a permanent quarantine, which is the outcome the expiry rule exists to prevent.
 */
export const expiredQuarantineEntries = (args: {
  readonly ledger: QuarantineLedger
  readonly today: string
}): readonly (readonly [string, QuarantineEntry])[] =>
  Object.entries(args.ledger).filter(
    ([, entry]) => isExpired({ expires: entry.expires, today: args.today }) === true,
  )

/** The one-line human-readable form of a tolerated failure, used by both output channels. */
export const renderQuarantineAnnouncement = (args: {
  readonly label: string
  readonly entry: QuarantineEntry
}): string =>
  `Quarantined failure: ${args.label} — ${args.entry.reason} Tracking ${args.entry.issue}, expires ${args.entry.expires}.`

/**
 * Resolves a quarantine key against a ledger, rejecting the two ways a quarantine can lie.
 *
 * A caller's type checker may already reject an unknown key, but a cast, a JS caller, or a
 * hand-written CLI invocation can still get here — and silently treating an unknown quarantine
 * as "suppress everything" is the failure this whole mechanism exists to prevent. The ledger's
 * `target` is the declaration of what is suppressed, so it is enforced rather than decorative:
 * without the second check, one entry's key could suppress an unrelated target under another
 * target's reason, issue, and expiry.
 */
export const resolveQuarantineEntry = (args: {
  readonly ledger: QuarantineLedger
  readonly key: string
  readonly label: string
}): QuarantineEntry => {
  const entry = args.ledger[args.key]

  if (entry === undefined) {
    throw new Error(`Quarantine '${args.key}' has no entry in the ledger.`)
  }

  if (entry.target !== args.label) {
    throw new Error(
      `Quarantine '${args.key}' declares target ${JSON.stringify(entry.target)} but was applied to ${JSON.stringify(args.label)}.`,
    )
  }

  return entry
}

/** The GitHub annotation form of an announcement. */
export const renderQuarantineAnnotation = (summary: string): string =>
  `::warning title=Quarantined test failure::${summary}`

/** The job-summary line form of an announcement, including its trailing newline. */
export const renderQuarantineSummaryLine = (summary: string): string => `- ${summary}\n`

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

const isExpired = (args: { readonly expires: string; readonly today: string }): boolean =>
  isoDatePattern.test(args.expires) === false || args.expires < args.today
