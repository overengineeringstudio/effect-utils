# The editor refuses pages with lossy blocks instead of reconciling them

> **Broadened by [0017](./0017-edit-is-an-ephemeral-file-engine-session.md)** to
> uniform refusal across `cat`/`put`/`edit` and the file-based `sync`. Read
> "streaming editor" below as "the editor surface."

The editor (`cat`/`put`/`edit`) targets the **representable-Markdown majority**. A page whose body contains any **not-losslessly-representable block**
— `child_database`, `synced_block`, `table_of_contents`, `child_page`, the API
`unsupported` type, and similar — is **refused** (exit 3,
`NmdRemoteBodyLossyError`) at read time, with a clear message pointing the user
to the Notion UI or the file-based `.nmd` sync path. The editor never presents
or pushes a body it cannot round-trip.

## Why

Live experimentation mapped a hard platform ceiling that bars the parts of the
"edit everything as Markdown" ideal which motivated the heavy reconciler:

- **No backlink / inbound-reference endpoint.** Repositioning a `synced_block`
  original or any referenced block must mint a new id, silently breaking inbound
  references the API cannot enumerate.
- **`child_database` is uncreatable via the block API**, so recreate-move is
  impossible for it by platform limitation.
- **The Markdown endpoint is lossy and non-injective** (a callout and a quote
  both render `> 💡 hello`), so a reconstruct-from-Markdown push corrupts.

Given that ceiling, the elegant design serves the representable majority cleanly
and refuses the rest **honestly** rather than building a reconciler / converter /
recreate-move edifice that is partly impossible and fragile where possible.

Crucially, **refuse-lossy is the pre-existing posture, not a new invention.** The
file-based path already refuses lossy observations for clean-base adoption
(`assertSnapshotComplete`) and already pushes representable bodies through the
Markdown endpoint with live E2E coverage. Abandoning the reconciler returns the
streaming path to the posture the file-based path always had; the
renderer-symmetric converter was only ever needed for client-side block
reconstruction inside the reconciler, which is now gone — so the
representable-body push path needs no new verification.

This honors the user's explicit choice ("refuse lossy pages, clean ideal") and is
**honest scope, not an MVP cop-out**: it is the smallest, most elegant design the
platform actually permits.

## Status

accepted

## Consequences

- **`put` is a guarded body replace** (`replaceRemoteBodyVerified` →
  `replace_content`) plus a typed title / property write — **two writes, not a
  block-op sequence** (decision 0012). Because the body contains no opaque blocks,
  `replace_content` can never destroy one.
- **Supersedes the reconciler edifice** — inline id-carrying placeholders,
  visible-placeholder deletion as normal editing, block-level reconciliation by
  id, reconciliation as the universal push engine, and the renderer-symmetric
  Markdown↔block converter are all abandoned (their decision records are removed;
  rationale in [experiments.md](../experiments.md)). No `<notion-block id>` token,
  no recreate-move.
- **Exit 3 flips from a rare fallback to the defining refusal.** It names the
  refused block classes and points to the Notion UI / file-based sync. The
  reconciler-only **exit 11** (opaque-move-unsupported) is deleted.
- **R38 survives, repurposed.** The body-fidelity classifier must still flag
  every not-losslessly-representable block — but now to drive the **refusal
  gate** (refuse the page up front) rather than to id-anchor a placeholder. This
  is a correctness prerequisite: today `child_database`/`toc` classify
  `complete`, so without R38 a `replace_content` would silently destroy them.
- **Refusing all synced-original / inbound-referenced moves is subsumed**: such
  blocks are simply refused with the page.
- **Hosted media stays in scope** (representable; only its URL is volatile —
  decision 0007). Media pages are **not** refused. Whether a canonicalized
  (non-fetchable) hosted-media URL survives a full `replace_content` round-trip
  is an implementation-verification item, not a spec refusal.
- The file-based path keeps its existing **Markdown** three-way merge and
  guarded `replace_content`; it is not rewritten onto a block engine.
- Decision 0007 (media canonicalization) is unaffected; 0006 (writable-projection
  guard) and 0008 (scope boundary) stand. (The stateless schema fingerprint this
  record once called "unaffected" was later superseded by 0017.)
