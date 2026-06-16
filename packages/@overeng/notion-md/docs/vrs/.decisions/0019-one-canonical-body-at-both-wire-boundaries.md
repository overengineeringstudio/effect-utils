# Canonical body is one function applied at BOTH wire boundaries

The body has **one renderer** (`treeToMarkdown`) and **one canonicalizer**
(`canonicalizeBlockMarkdown`). They are wired so that **both** wire boundaries —
pull receive and push send — route the body through the single canonicalizer, so
the body a consumer reads (`cat` / `edit` / file sync / baseline), the body
hashed/compared, and the body pushed are the _same canonical bytes_.

- The **renderer emits parseable-not-canonical Markdown**: it joins sibling
  blocks (including consecutive list items) with `\n\n` so they stay distinct
  after a parse. It carries **no spacing/tightness policy** and its joins must
  **not** be made block-type-aware — that would re-split spacing policy across
  two serializers and reintroduce the divergence this decision removes.
- **Spacing / list-tightness policy lives only in the canonical layer.**
  `canonicalizeBlockMarkdown` is: line-ending normalize → media-URL canonicalize
  → remark parse + GFM → `unwrapSoftBreaks` → `forceTightLists` (`spread = false`
  on every list / list item) → remark-stringify → single trailing `\n`.
- The canonical function lives in `@overeng/notion-effect-client`, beside the
  renderer and the media-URL canonicalizer it calls. `observeFromSnapshots`
  canonicalizes the rendered body **once, at the source**, before it flows into
  the inventory, the fidelity classifier, and the evidence fingerprint, so all of
  them agree by construction. `semanticEquivalent` (the push integrity gate)
  stays in `@overeng/notion-md` — it is sync _policy_, not the wire form.

## Why

Before this, pull emitted the raw renderer output (always-loose lists, headings
correct) while push canonicalized through remark (tightness follows input). The
two serializers never reconciled — a two-oracle divergence. It surfaced as the
loose-bullet-list line-break bug and a stray indented blank line inside nested
lists, and was only _masked_ (not caught) by `semanticEquivalent`'s
whitespace-collapse. Routing both boundaries through one function makes pull and
push agree by construction: the line-break bug cannot recur because exactly one
place decides spacing and both boundaries read from it.

## Consequences

- **`semanticEquivalent` is unaffected.** It canonicalizes both sides then
  collapses whitespace outside fenced code; loose-vs-tight differs only in
  inter-item blank lines (whitespace, non-code), so the gate is invariant across
  this change — it neither newly-fails nor newly-passes anything.
- **`update_content` is not a third un-canonical push.** `planMarkdownUpdate`
  diffs an already-canonical base/remote (both from pull) against a possibly-raw
  desired buffer and emits `oldStr`/`newStr` as **raw substrings Notion matches
  verbatim**. `desired` must **not** be canonicalized; the
  `remote.replace(oldStr, newStr) === desired` guard plus the canonicalizing
  `replace_content` fallback and the `semanticEquivalent` post-push gate cover
  correctness. The merge / 3-way normalization stays line-level.
- **The title↔H1 frame consumes the canonical body verbatim.** `editor-surface`
  frames an already-canonical body and must **not** re-canonicalize the
  title-framed buffer — the `# <title>` line is presentation, not body Markdown,
  and re-parsing it would break the load-bearing H1 round-trip.
- **The vestigial client `markdownToBlocks` converter is deleted.** Under
  refuse-lossy / one-engine (decision 0016), push sends a raw Markdown
  string to Notion's server-side `/markdown` endpoint; the client-side converter
  was on no path.
- **Body bytes change → body hashes change, once.** Any already-synced page with
  a list re-canonicalizes loose → tight on the next pull; the recorded base hash
  goes stale and shows as a benign one-time body change. For list-tightness the
  through-Notion fixpoint converges; the known **Case B** residual
  (paragraph-after-list, #756) is non-idempotent on Notion's server reparse and
  stays _masked_ by `semanticEquivalent` — pre-existing, not changed by this
  consolidation.

## Deliberate non-changes

- **`normalizeMarkdownLineEndings` stays** as the line-level sub-step (on-disk /
  title-frame / hash-prep). It is a step _of_ the canonical function, not a
  sibling, and is intentionally separate from block-level canonicalization.
- **`normalizeComparableMarkdown` / `normalizeLines` stay in `notion-core`.**
  Core is pure (zero deps, no Markdown parser); it cannot import the canonical
  function — and Option 2 puts that function in `notion-effect-client`, which
  _depends on_ core, so the constraint is permanent. The per-line `trimEnd` used
  by the fidelity suffix compare is a legitimately separate pure concern.
