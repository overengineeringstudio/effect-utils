# `cat` emits the base hash on stderr; standalone `put` needs `--base-hash` or `--force`

`cat` writes the [[Base hash]] to **stderr** (`base-hash: sha256:…`) and keeps
**stdout pure Markdown**, so `notion-md cat X | pandoc` and similar pipes work
unpolluted. The alternative (hash on stdout line 1) was rejected because it
would force every consumer to strip a header.

Consequence: a bare pipe can't carry the out-of-band token, so guarded `put`
needs the hash supplied explicitly. `put` with neither `--base-hash` nor
`--force` refuses and points to both. `edit` threads the hash internally so the
common path never sees it.

## Status

accepted

## Considered Options

- Hash on stdout line 1 — single capture gets body+token, but pollutes every
  pipe and breaks "stdout is pure Markdown."
- Hash on stderr (chosen) — pipe-clean stdout; power users capture stderr or
  use `--force`; `edit` hides it.
