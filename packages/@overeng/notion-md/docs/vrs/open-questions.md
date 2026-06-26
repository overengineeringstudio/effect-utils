# Open Questions

Unresolved design questions for `@overeng/notion-md`. Each links to a spec
`DQ`. A question leaves this file when resolved — into a decision record (or the
spec) as a decision, or into [experiments.md](./experiments.md) as a tested
hypothesis.

## OQ1 — Keep `cat` or defer casual reads to `ntn pages get`?

Spec ref: [spec.md `DQ1`](./spec.md#dq1--cat-vs-ntn-pages-get). Principle:
[decision 0021](./.decisions/0021-avoid-duplicating-official-ntn.md).

`cat` overlaps the official `ntn pages get`, and under the
avoid-duplicating-`ntn` principle every overlap needs a documented clear reason.
`cat`'s clear reason is narrow:

- **Edge it has:** it emits the **base hash** (the title+body optimistic-
  concurrency token that the guarded `put` consumes), and it **refuses a lossy
  page on read** (exit 3) so a guarded-workflow read never hands back a body that
  cannot be safely written back.
- **Where it is weaker:** for a casual, one-off read, `ntn pages get` is better —
  it prints the page with properties as frontmatter and surfaces a truncation
  warning (suggesting `--json` to inspect `unknown_block_ids`) that `cat`'s
  refuse-on-read posture does not offer.

The question: should `cat` stay as the **guarded-workflow read primitive only**
(documented as "use `ntn pages get` for casual reads"), or should the casual-read
command be **deprecated toward `ntn pages get`**, leaving only an internal
base-hash-emitting read for the `put` workflow?

Resolves when we decide whether base-hash emission warrants a standalone
user-facing command or should fold into the `put`/`edit` workflow with casual
reads pointed at `ntn`.
