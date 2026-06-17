/**
 * Schema source-of-truth for the `/sk-cli-design` CLI-output kit.
 *
 * These JSON-encodable schemas are the building blocks that per-command state
 * schemas (notion-md, notion-cli, megarepo) compose later. Components in this
 * module render values shaped by these schemas through the active OutputMode
 * seam (colors / unicode honored automatically).
 *
 * @module
 */

import { Schema } from 'effect'

/**
 * Problem severity.
 *
 * - `critical`: blocking issue that prevents work (rendered as a CRITICAL badge)
 * - `warning`: needs attention but not blocking (rendered as a WARNING badge)
 */
export const Severity = Schema.Literal('critical', 'warning')
/** Inferred severity literal (`'critical' | 'warning'`). */
export type Severity = Schema.Schema.Type<typeof Severity>

/**
 * A single problem item shown in the problems-first section.
 *
 * Renders as: bold `name`, dimmed `status`/`details`, an optional dimmed
 * `context` line, then cyan `fix:` lines and dimmed `skip:` lines.
 */
export const ProblemItem = Schema.Struct({
  /** Severity bucket — drives which badge groups the item. */
  severity: Severity,
  /** Short identifier (file, env var, …) — rendered bold. */
  name: Schema.String,
  /** One-word state (e.g. `blocked`, `missing`) — rendered dim. */
  status: Schema.String,
  /** Human-readable explanation — rendered dim. */
  details: Schema.String,
  /** Optional extra context line — rendered dim. */
  context: Schema.optional(Schema.String),
  /** Suggested fix commands — each rendered as a cyan `fix:` line. */
  fixes: Schema.Array(Schema.String),
  /** Optional ways to ignore/suppress — each rendered as a dim `skip:` line. */
  skips: Schema.optional(Schema.Array(Schema.String)),
})
/** A single problem item (derived from {@link ProblemItem}). */
export type ProblemItem = Schema.Schema.Type<typeof ProblemItem>

/**
 * A titled subsection of detail items with optional truncation.
 *
 * Renders as a `title(count):` header, up to 5 items, then a dimmed
 * `+ N more` when `more > 0`.
 */
export const DetailSection = Schema.Struct({
  /** Section title — combined with the item count in the header. */
  title: Schema.String,
  /** Detail lines — rendered dim, capped at 5 displayed. */
  items: Schema.Array(Schema.String),
  /** Count of items omitted beyond the displayed ones (drives `+ N more`). */
  more: Schema.optional(Schema.Number),
})
/** A detail section (derived from {@link DetailSection}). */
export type DetailSection = Schema.Schema.Type<typeof DetailSection>

/**
 * Main-item status, mapping to a glyph via {@link StatusGlyph}.
 *
 * `modified` → `*`, `diverged` → `↕`, `ok` → `✓`, `error` → `✗`.
 */
export const StatusSymbol = Schema.Literal('modified', 'diverged', 'ok', 'error')
/** Inferred status-symbol literal. */
export type StatusSymbol = Schema.Schema.Type<typeof StatusSymbol>
