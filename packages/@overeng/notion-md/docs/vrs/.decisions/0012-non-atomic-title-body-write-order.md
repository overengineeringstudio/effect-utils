# A default-mode `put` is two non-atomic writes: body first, title last, partial failure reported

> **Scoped by [0017](./0017-edit-is-an-ephemeral-file-engine-session.md) to the
> stateless `put`.** `edit` is an ephemeral file-engine session and inherits the
> engine's settle-and-re-pull, so the exit-10 partial-write model below applies to
> `put` (body + title, two writes), not to `edit`.

A default-mode `put` performs **two** remote writes — the body
(`replaceRemoteBodyVerified` → `replace_content`) and the title (typed page API).
Notion has no transaction across them, so either can fail independently.

Decision:

- **Order:** body first, title last. The title write is cheap and idempotent, so
  doing it last narrows the partial-failure window and a retry re-applies it
  harmlessly.
- **Partial failure:** if one write lands and the other fails, report exactly
  which landed, fail with **exit 10** (`NmdPartialWriteError`), and state the page
  is in a mixed state with a stale base hash. Never silent exit 0.
- **Precedence:** a known partial write (exit 10) **dominates** the post-push
  semantic-equivalence gate (exit 9) — once one write is known to have landed and
  the other failed, report exit 10 and skip the gate.
- **Recovery:** re-`cat` (the page is authoritative), then re-edit.

`--frontmatter` mode can additionally write writable properties; the same
ordering principle applies (body, then page-level title/metadata/properties),
and a mid-sequence failure is reported the same way.

## Why

A body replace and a typed title write are genuinely separate API calls with no
shared transaction. Modelling `put` as an ordered pair with body-first ordering
and a clear exit-10-dominates-exit-9 rule is the honest, recoverable model.

## Status

accepted

## Consequences

- Exit 10 (`NmdPartialWriteError`) carries which write landed; exit 9 only fires
  when both writes completed but the result is not semantically equivalent.
- The body is replaced in a single `replace_content` call (decision 0016), so
  there is no intra-body op sequence to partially apply — the only partial state
  is body-applied / title-not (or the reverse).
