/**
 * Cross-surface canonical comparability for local convergence (Phase 4, SM5c).
 *
 * A property edited in the SQLite `pages` data file stores its desired value as a
 * canonical JSON string (`value_json`), and the planner hashes that string with
 * `hashStoreBytes`. To converge the same property edited in the page's `.nmd`
 * frontmatter, the `.nmd` value must hash to a BYTE-IDENTICAL string — otherwise
 * equal user intent produces different hashes and every shared-mode push
 * false-conflicts.
 *
 * The `.nmd` frontmatter stores a `NmdWritablePropertyValue` (e.g.
 * `{_tag:'select', value:'Done'}`), which is NEITHER the raw Notion API shape NOR
 * the datasource-sync `CanonicalPropertyValue` (`{_tag:'select', option:{...}}`).
 * This module bridges the two through the SINGLE shared canonical encoder
 * (`@overeng/notion-effect-schema`'s `makeCanonicalCodec`), the exact codec the
 * pull path uses to produce `value_json`:
 *
 *   NmdWritablePropertyValue → raw Notion shape → codec.decodeSync → CanonicalPropertyValue
 *   → JSON.stringify → hashStoreBytes
 *
 * Routing through `codec.decodeSync` (rather than hand-building the canonical
 * literal) keeps the canonical byte form single-sourced: the SQLite trigger's
 * `json_object(...)` output and this path are proven byte-identical for the scalar
 * types editable through the public `pages` surface (see the two-oracle test).
 *
 * SCOPE — scalar types only. The public `pages` SQL surface only lets a user edit
 * SCALAR property columns (`rowsCanonicalValueExpression` returns NULL for
 * `multi_select`/`relation`/`people`/`files`), so a property DIVERGENCE is only
 * possible for scalar types. A non-scalar `.nmd` property edit can only ever be a
 * single-surface intent, never a cross-surface conflict. `nmdPropertyDesiredHash`
 * therefore returns `undefined` for non-scalar/unsupported tags: the caller emits
 * no property fact for them, leaving them to the single-surface path.
 *
 * @module
 */

import { Option } from 'effect'

import type { NmdWritablePropertyValue } from '@overeng/notion-effect-client'
import { makeCanonicalCodec, type CanonicalPropertyValueType } from '@overeng/notion-effect-schema'

import { canonicalHash } from '../core/canonical.ts'
import type { Hash } from '../core/domain.ts'
import { hashStoreBytes } from '../store/projections.ts'

/* The codec's hashing policy is datasource-sync's `canonicalHash`, matching the gateway. */
const codec = makeCanonicalCodec({ hash: (value) => canonicalHash(value) })

/**
 * Normalize a canonical-property `value_json` into the single CONVERGENCE space
 * that the `.nmd` surface can also reach, then hash it.
 *
 * The three surfaces encode the SAME user value differently, and convergence
 * must compare like with like:
 *
 * - SELECT/STATUS option: the pull path keeps the full remote option
 *   (`{id, name, color}` via `canonicalOptionFromRemote`), but the `.nmd`
 *   frontmatter is name-only (`{_tag:'select', value:'Done'}`) and can NEVER
 *   reconstruct the id/color. So the comparison space is name-only: strip
 *   `option.id`/`option.color`. (The SQLite `pages` trigger already emits
 *   name-only, so it is unchanged by this.)
 * - Cleared NUMBER/DATE: the codec maps a null number/date to `{_tag:'empty'}`,
 *   but the SQLite `pages` trigger emits `{_tag:'number','value':null}` /
 *   `{_tag:'date','start':null,...}`. Fold both cleared shapes to `{_tag:'empty'}`
 *   so a cleared scalar converges across surfaces.
 *
 * Direction is forced: bring the richer remote/SQLite base DOWN to the name-only
 * `.nmd` space, never the other way (the `.nmd` side structurally lacks the
 * dropped fields). Pure JSON→JSON; key order otherwise preserved.
 */
const toConvergenceForm = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  switch (record._tag) {
    case 'select':
    case 'status': {
      const option = record.option
      if (option === null || typeof option !== 'object') return record
      const opt = option as Record<string, unknown>
      // Name-only option: drop id/color, which the `.nmd` surface cannot carry.
      return { _tag: record._tag, option: { _tag: opt._tag, name: opt.name } }
    }
    case 'number':
      // Cleared number: SQLite emits `value:null`; the codec emits `empty`.
      return record.value === null ? { _tag: 'empty' } : record
    case 'date':
      // Cleared date: SQLite emits `start:null`; the codec emits `empty`.
      return record.start === null || record.start === undefined ? { _tag: 'empty' } : record
    default:
      return record
  }
}

/**
 * The CONVERGENCE hash of a canonical `value_json` — the SINGLE hasher every
 * convergence comparison routes through (the `.nmd` desired fact, the SQLite
 * edit, and the observed base), so they compare in one consistent space. It is
 * the hash stored at pull time as `_nds_replica_cells.convergence_hash`.
 *
 * It parses, folds via {@link toConvergenceForm} (name-only options, cleared
 * scalars → `empty`), then re-stringifies. The parse→stringify round-trip ALSO
 * normalizes two encoding-only differences for free:
 *
 * - SQLite stores numbers through a `REAL` column, so a user edit serializes `42`
 *   as `42.0`; `JSON.parse('42.0')` is `42` and re-stringifies to `42`, matching
 *   the `.nmd`/pull form.
 * - JSON string-escaping across the SQL `json_object(...)` oracle and TS
 *   `JSON.stringify`.
 *
 * Key order is otherwise preserved (parse keeps insertion order), so the canonical
 * key-order discipline is untouched. This is the comparison hash, NEVER the
 * remote-write `desiredHash` (which keeps the full canonical, id+color included).
 */
export const convergenceFormHash = (canonicalValueJson: string): Hash =>
  hashStoreBytes(JSON.stringify(toConvergenceForm(JSON.parse(canonicalValueJson) as unknown)))

/**
 * Project a `.nmd` frontmatter writable property value into the RAW Notion API
 * shape the canonical codec decodes. Only the SCALAR tags editable through the
 * public `pages` surface are mapped; every other tag returns `undefined` so the
 * caller treats it as non-convergence-comparable (single-surface only).
 *
 * The raw shape mirrors `encodeCanonicalPropertyValue` (canonical → raw) so the
 * round-trip `.nmd → raw → canonical` reproduces the same `CanonicalPropertyValue`
 * the pull path produced from the live Notion value.
 */
const nmdWritableToRawNotion = (
  value: NmdWritablePropertyValue,
): Record<string, unknown> | undefined => {
  switch (value._tag) {
    case 'title':
      return {
        type: 'title',
        title: value.value.length === 0 ? [] : [{ type: 'text', plain_text: value.value }],
      }
    case 'rich_text':
      return {
        type: 'rich_text',
        rich_text:
          value.value === null || value.value.length === 0
            ? []
            : [{ type: 'text', plain_text: value.value }],
      }
    case 'number':
      return value.value === null
        ? { type: 'number', number: null }
        : { type: 'number', number: value.value }
    case 'checkbox':
      return { type: 'checkbox', checkbox: value.value }
    case 'date':
      return value.value === null
        ? { type: 'date', date: null }
        : { type: 'date', date: { start: value.value.start, end: value.value.end } }
    case 'select':
      return {
        type: 'select',
        select: value.value === null ? null : { name: value.value },
      }
    case 'status':
      return {
        type: 'status',
        status: value.value === null ? null : { name: value.value },
      }
    case 'email':
      return { type: 'email', email: value.value }
    case 'url':
      return { type: 'url', url: value.value }
    case 'phone_number':
      return { type: 'phone_number', phone_number: value.value }
    // Non-scalar / non-`pages`-editable tags are not convergence-comparable.
    case 'multi_select':
    case 'people':
    case 'files':
    case 'relation':
    case 'place':
    case 'verification':
      return undefined
  }
}

/**
 * The canonical value this `.nmd` writable property asserts, as the planner would
 * see it — or `undefined` when the tag is not convergence-comparable (non-scalar)
 * or the codec declines the projected raw value.
 */
export const nmdPropertyCanonicalValue = (
  value: NmdWritablePropertyValue,
): CanonicalPropertyValueType | undefined => {
  const raw = nmdWritableToRawNotion(value)
  if (raw === undefined) return undefined
  return Option.getOrUndefined(codec.decodeSync(raw))
}

/**
 * The CONVERGENCE hash for a `.nmd` writable property, comparable to the SQLite
 * `pages` side's value via {@link convergenceHash}. `undefined` when the tag is
 * not convergence-comparable (the caller emits no property fact, leaving the edit
 * to the single-surface path).
 *
 * This is the comparison hash, NOT the remote-write `desiredHash`: the latter
 * stays the raw `hashStoreBytes(change.valueJson)` on the SQLite intent that wins
 * a coalesce.
 */
export const nmdPropertyDesiredHash = (value: NmdWritablePropertyValue): Hash | undefined => {
  const canonical = nmdPropertyCanonicalValue(value)
  if (canonical === undefined) return undefined
  return convergenceFormHash(JSON.stringify(canonical))
}
